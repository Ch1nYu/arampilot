//! Cached augment and item tables: display names, rarities and icon asset paths.
//!
//! Only the local client knows these by id: `GET
//! /lol-game-data/assets/v1/cherry-augments.json` (600 entries as measured on
//! 2026-11-26, `nameTRA` already in 繁中) and `.../v1/items.json`. Both are
//! fetched once, mirrored to `game-data.json` in the app data folder so they
//! survive a client restart, and kept in a process cache so the icon protocol
//! can resolve an id without a request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::icon_cache::IconKey;
use crate::lcu::LcuManager;

/// LCU path of the augment table.
const AUGMENTS_PATH: &str = "/lol-game-data/assets/v1/cherry-augments.json";
/// LCU path of the item table.
const ITEMS_PATH: &str = "/lol-game-data/assets/v1/items.json";
/// File the tables are mirrored to inside the app data folder.
const DATA_FILE: &str = "game-data.json";
/// Shortest wait between two client fetches, even when ids stay unknown: a
/// stale id must not cost a request on every call.
const FETCH_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// One augment of the client's augment table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AugmentEntry {
    /// Localized name (`nameTRA`); empty when the client gave none.
    pub name: String,
    /// `silver`, `gold`, `prismatic` or empty when unknown.
    pub rarity: String,
    /// Client asset path (`augmentSmallIconPath`); empty when unknown.
    pub icon: String,
}

/// One item of the client's item table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemEntry {
    /// Localized name; empty when the client gave none.
    pub name: String,
    /// Client asset path (`iconPath`); empty when unknown.
    pub icon: String,
}

/// Both lookup tables, keyed by id.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameData {
    pub augments: HashMap<i64, AugmentEntry>,
    pub items: HashMap<i64, ItemEntry>,
}

/// Map the client's rarity key to the frontend's rarity name; anything else
/// (`kEventChoice`, an empty string) has no rarity.
pub fn normalize_rarity(raw: &str) -> String {
    match raw {
        "kSilver" => "silver",
        "kGold" => "gold",
        "kPrismatic" => "prismatic",
        _ => "",
    }
    .to_string()
}

/// A string field of `entry`, or `""` when it is missing or not a string.
fn text(entry: &Value, key: &str) -> String {
    entry
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// The entry's id, when it is a positive integer.
fn positive_id(entry: &Value) -> Option<i64> {
    entry.get("id").and_then(Value::as_i64).filter(|id| *id > 0)
}

/// Parse `cherry-augments.json` into the augment table. Entries without a
/// positive id are skipped, missing or non-string fields read as `""`, and a
/// body that is not an array yields an empty table.
pub fn parse_augments(v: &Value) -> HashMap<i64, AugmentEntry> {
    let Some(entries) = v.as_array() else {
        return HashMap::new();
    };
    let mut table = HashMap::with_capacity(entries.len());
    for entry in entries {
        let Some(id) = positive_id(entry) else {
            continue;
        };
        table.insert(
            id,
            AugmentEntry {
                name: text(entry, "nameTRA"),
                rarity: normalize_rarity(&text(entry, "rarity")),
                icon: text(entry, "augmentSmallIconPath"),
            },
        );
    }
    table
}

/// Parse `items.json` into the item table, with the same rules as
/// [`parse_augments`].
pub fn parse_items(v: &Value) -> HashMap<i64, ItemEntry> {
    let Some(entries) = v.as_array() else {
        return HashMap::new();
    };
    let mut table = HashMap::with_capacity(entries.len());
    for entry in entries {
        let Some(id) = positive_id(entry) else {
            continue;
        };
        table.insert(
            id,
            ItemEntry {
                name: text(entry, "name"),
                icon: text(entry, "iconPath"),
            },
        );
    }
    table
}

/// The augment names and rarities `match_history::parse_game_detail` needs.
pub fn augment_table(data: &GameData) -> HashMap<i64, crate::match_history::AugmentInfo> {
    data.augments
        .iter()
        .map(|(id, entry)| {
            (
                *id,
                crate::match_history::AugmentInfo {
                    name: entry.name.clone(),
                    rarity: entry.rarity.clone(),
                },
            )
        })
        .collect()
}

/// Path of the lookup table inside the app data folder.
pub fn data_path() -> PathBuf {
    crate::config::app_data_dir().join(DATA_FILE)
}

/// Read the table from `path`; a missing, unreadable or unparsable file reads
/// as an empty table so a corrupt mirror never blocks the lookup.
pub fn load_from(path: &Path) -> GameData {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return GameData::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Write the table to `path` atomically: create the folder if missing, write a
/// sibling temp file, then rename it over `path` so a crash never leaves a
/// half-written mirror behind.
pub fn save_to(path: &Path, data: &GameData) -> std::io::Result<()> {
    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);
    let json = serde_json::to_string(data).map_err(std::io::Error::other)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| DATA_FILE.to_string());
    let seq = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()));
    std::fs::write(&tmp, json)?;
    let renamed = std::fs::rename(&tmp, path);
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed
}

/// The process-wide table, read from disk on first use.
fn cache() -> &'static Mutex<GameData> {
    static CACHE: LazyLock<Mutex<GameData>> = LazyLock::new(|| Mutex::new(load_from(&data_path())));
    &CACHE
}

/// Lock [`cache`], recovering a poisoned guard: the table is plain data and
/// stays usable after a panic elsewhere.
fn cached() -> std::sync::MutexGuard<'static, GameData> {
    cache().lock().unwrap_or_else(|e| e.into_inner())
}

/// Client asset path of an augment or item icon, `None` for any other key,
/// an unknown id, or an entry the client gave no icon path for.
pub fn icon_asset_path(key: &IconKey) -> Option<String> {
    let data = cached();
    let icon = match key {
        IconKey::Augment(id) => &data.augments.get(id)?.icon,
        IconKey::Item(id) => &data.items.get(id)?.icon,
        IconKey::Champion(_) | IconKey::Spell(_) => return None,
    };
    (!icon.is_empty()).then(|| icon.clone())
}

/// When the tables were last asked from the client, so a still-unknown id does
/// not trigger a fetch on every call.
fn last_fetch() -> &'static Mutex<Option<Instant>> {
    static LAST: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));
    &LAST
}

/// Whether a client fetch is allowed now.
fn fetch_due() -> bool {
    let last = *last_fetch().lock().unwrap_or_else(|e| e.into_inner());
    last.is_none_or(|at| at.elapsed() >= FETCH_INTERVAL)
}

/// Remember the attempt, so the next call within [`FETCH_INTERVAL`] waits.
fn mark_fetched() {
    *last_fetch().lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
}

/// Whether any non-zero id is still missing from the cached table.
fn has_missing(data: &GameData, augment_ids: &[i64], item_ids: &[i64]) -> bool {
    augment_ids
        .iter()
        .any(|id| *id > 0 && !data.augments.contains_key(id))
        || item_ids
            .iter()
            .any(|id| *id > 0 && !data.items.contains_key(id))
}

/// The lookup tables, re-fetched from the connected client once when an id is
/// missing and the last attempt is older than [`FETCH_INTERVAL`].
///
/// Each table is replaced only when its downloaded parse is non-empty, so a
/// failed or partially broken fetch never empties a working lookup. Nothing is
/// asked of a client that is not connected.
pub async fn ensure(lcu: &LcuManager, augment_ids: &[i64], item_ids: &[i64]) -> GameData {
    let missing = {
        let data = cached();
        has_missing(&data, augment_ids, item_ids)
    };
    if !missing || !fetch_due() || !lcu.is_connected().await {
        return cached().clone();
    }
    // Claim the attempt before the awaits: two concurrent callers must not
    // both fetch. No guard is held across an await.
    mark_fetched();

    let mut fetched_augments = None;
    if let Ok(bytes) = lcu.fetch_asset(AUGMENTS_PATH).await
        && let Ok(body) = serde_json::from_slice::<Value>(&bytes)
    {
        let parsed = parse_augments(&body);
        if !parsed.is_empty() {
            fetched_augments = Some(parsed);
        }
    }
    let mut fetched_items = None;
    if let Ok(bytes) = lcu.fetch_asset(ITEMS_PATH).await
        && let Ok(body) = serde_json::from_slice::<Value>(&bytes)
    {
        let parsed = parse_items(&body);
        if !parsed.is_empty() {
            fetched_items = Some(parsed);
        }
    }

    if fetched_augments.is_none() && fetched_items.is_none() {
        return cached().clone();
    }
    let updated = {
        let mut data = cached();
        if let Some(augments) = fetched_augments {
            data.augments = augments;
        }
        if let Some(items) = fetched_items {
            data.items = items;
        }
        data.clone()
    };
    // Written after the guard is dropped: a failed write only costs the next
    // process a refetch, the in-memory table is already current.
    let _ = save_to(&data_path(), &updated);
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Unique temp folder for one test, cleared of any earlier run's leftovers.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arampilot-game-data-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn test_parse_augments_treats_blank_names_as_missing() {
        // The live client (2026-11-26) ships augment 3176 with the name "   ".
        let parsed = parse_augments(&serde_json::json!([
            { "id": 3176, "nameTRA": "   ", "rarity": "kGold", "augmentSmallIconPath": "/a.png" }
        ]));
        assert_eq!(parsed[&3176].name, "");
        assert_eq!(parsed[&3176].rarity, "gold");
    }

    #[test]
    fn test_normalize_rarity_maps_the_client_keys() {
        assert_eq!(normalize_rarity("kSilver"), "silver");
        assert_eq!(normalize_rarity("kGold"), "gold");
        assert_eq!(normalize_rarity("kPrismatic"), "prismatic");
        // Event augments and empty input carry no rarity.
        assert_eq!(normalize_rarity("kEventChoice"), "");
    }

    #[test]
    fn test_parse_augments_reads_name_rarity_and_icon() {
        let body = json!([
            {
                "id": 2141,
                "nameTRA": "終極九頭蛇",
                "rarity": "kPrismatic",
                "augmentSmallIconPath": "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/UltraHydra_small.png"
            },
            {
                "id": 0,
                "nameTRA": "not an augment",
                "rarity": "kSilver",
                "augmentSmallIconPath": "/lol-game-data/assets/ASSETS/zero.png"
            },
            {"id": 7},
            {"nameTRA": "no id at all"}
        ]);
        let table = parse_augments(&body);
        assert_eq!(table.len(), 2, "only the positive ids are kept");
        assert_eq!(
            table.get(&2141),
            Some(&AugmentEntry {
                name: "終極九頭蛇".to_string(),
                rarity: "prismatic".to_string(),
                icon: "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/UltraHydra_small.png"
                    .to_string(),
            })
        );
        assert_eq!(
            table.get(&7),
            Some(&AugmentEntry {
                name: String::new(),
                rarity: String::new(),
                icon: String::new(),
            })
        );
    }

    #[test]
    fn test_parse_items_reads_name_and_icon() {
        let body = json!([
            {
                "id": 3071,
                "name": "黑色切割者",
                "iconPath": "/lol-game-data/assets/ASSETS/Items/Icons2D/3071_Fighter_T3_BlackCleaver.png"
            },
            {
                "id": 0,
                "name": "no item id",
                "iconPath": "/lol-game-data/assets/ASSETS/zero.png"
            },
            {"id": 226668},
            {"iconPath": "/lol-game-data/assets/ASSETS/no-id.png"}
        ]);
        let table = parse_items(&body);
        assert_eq!(table.len(), 2, "only the positive ids are kept");
        assert_eq!(
            table.get(&3071),
            Some(&ItemEntry {
                name: "黑色切割者".to_string(),
                icon: "/lol-game-data/assets/ASSETS/Items/Icons2D/3071_Fighter_T3_BlackCleaver.png"
                    .to_string(),
            })
        );
        assert_eq!(
            table.get(&226668),
            Some(&ItemEntry {
                name: String::new(),
                icon: String::new(),
            })
        );
    }

    #[test]
    fn test_parse_tables_from_non_arrays_are_empty() {
        assert!(parse_augments(&json!({"id": 2141})).is_empty());
        assert!(parse_augments(&Value::Null).is_empty());
        assert!(parse_items(&json!("not an array")).is_empty());
        assert!(parse_items(&Value::Null).is_empty());
    }

    #[test]
    fn test_save_and_load_round_trip() {
        let dir = temp_dir("round-trip");
        let path = dir.join(DATA_FILE);
        let mut data = GameData::default();
        data.augments.insert(
            2141,
            AugmentEntry {
                name: "終極九頭蛇".to_string(),
                rarity: "prismatic".to_string(),
                icon: "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/UltraHydra_small.png"
                    .to_string(),
            },
        );
        data.items.insert(
            3071,
            ItemEntry {
                name: "黑色切割者".to_string(),
                icon: "/lol-game-data/assets/ASSETS/Items/Icons2D/3071_Fighter_T3_BlackCleaver.png"
                    .to_string(),
            },
        );

        // The folder does not exist yet: save creates it.
        save_to(&path, &data).expect("save should create the folder and the file");
        assert_eq!(load_from(&path), data);

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("list the folder")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no .tmp file may remain");

        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }

    #[test]
    fn test_load_from_missing_or_corrupt_file_is_default() {
        let dir = temp_dir("load-bad");
        let path = dir.join(DATA_FILE);
        assert_eq!(load_from(&path), GameData::default(), "missing file");

        std::fs::create_dir_all(&dir).expect("create the folder");
        std::fs::write(&path, b"{ not json").expect("write a corrupt file");
        assert_eq!(load_from(&path), GameData::default(), "corrupt file");

        std::fs::write(&path, b"").expect("write an empty file");
        assert_eq!(load_from(&path), GameData::default(), "empty file");

        std::fs::remove_dir_all(&dir).expect("temp folder removed");
    }
}
