pub mod config;
pub mod engine;
pub mod fatal;
pub mod lcu;
pub mod livegame;
pub mod single_instance;

use config::{AppConfig, ConfigManager, SaveError};
use engine::{
    BenchDecision, CardDecision, ChampSelectRuleEngine, ChampSelectSessionTracker, TradeDecision,
};
use lcu::{ChampionItem, ConnectionStatus, LcuManager};
use livegame::LiveGamePoller;
use std::sync::Arc;
use std::time::Instant;
use tauri::async_runtime::spawn;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, Wry};
use tokio::sync::RwLock;

type SharedLcu = Arc<LcuManager>;
type SharedConfig = Arc<RwLock<AppConfig>>;
type SharedTracker = Arc<tokio::sync::Mutex<ChampSelectSessionTracker>>;

/// Identity of the currently logged-in LoL account, shown in the UI. Settings
/// and rankings belong to this computer, not to the account.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ActiveAccount {
    pub puuid: String,
    /// `gameName#tagLine` (falls back to legacy `displayName`).
    pub display_name: String,
}

type SharedAccount = Arc<RwLock<Option<ActiveAccount>>>;

/// Detect the logged-in account for display only.
///
/// Runs on every LCU connect; a no-op while the same account is active. It
/// never loads or swaps the config: `config.json` is the same for every account.
async fn sync_active_account(
    app: &tauri::AppHandle,
    lcu: &SharedLcu,
    account_lock: &SharedAccount,
) -> bool {
    let Some(raw) = lcu.fetch_current_summoner().await else {
        return false;
    };
    let Some(info) = lcu::parse_account_identity(&raw) else {
        return false;
    };
    let account = ActiveAccount {
        puuid: info.puuid.clone(),
        display_name: info.display_name.clone(),
    };
    let already_current = {
        let mut acc = account_lock.write().await;
        if acc.as_ref().map(|a| a.puuid.as_str()) == Some(info.puuid.as_str()) {
            true
        } else {
            *acc = Some(account.clone());
            false
        }
    };
    if already_current {
        return true;
    }

    let _ = app.emit("account-changed", &account);
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "sys",
            "title": "目前帳號",
            "reason": account.display_name,
        }),
    );
    true
}

/// The client often reports its port before the summoner is loaded: keep
/// trying for ~30s so the account name appears without an LCU reconnect.
fn retry_account_sync(
    app: tauri::AppHandle,
    lcu: SharedLcu,
    account_lock: SharedAccount,
) {
    spawn(async move {
        for _ in 0..15 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if !lcu.is_connected().await {
                return;
            }
            if sync_active_account(&app, &lcu, &account_lock).await {
                return;
            }
        }
    });
}

/// Backend-owned champ select state pushed to the overview card.
///
/// The frontend renders the verdicts instead of recomputing them, so the UI and
/// the rule engine can never disagree about what the backend decided.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ChampSelectUiState {
    pub manual_hold_champ_id: Option<i32>,
    pub bench_retry_target: Option<i32>,
    pub bench_verdict: Option<String>,
    pub trade_verdict: Option<String>,
    pub allied_puuids: Vec<String>,
    pub allied_summoner_ids: Vec<i64>,
}

/// Snapshot the tracker as the serializable overview state.
fn champ_select_ui_state(tr: &ChampSelectSessionTracker) -> ChampSelectUiState {
    ChampSelectUiState {
        manual_hold_champ_id: tr.manual_bench_hold,
        bench_retry_target: tr.bench_retry_target,
        bench_verdict: tr.last_bench_verdict.clone(),
        trade_verdict: tr.last_trade_verdict.clone(),
        allied_puuids: tr.allied_puuids.iter().cloned().collect(),
        allied_summoner_ids: tr.allied_summoner_ids.iter().copied().collect(),
    }
}

/// Push the current champ select state to the frontend.
fn emit_champ_select_state(app_handle: &tauri::AppHandle, tr: &ChampSelectSessionTracker) {
    let _ = app_handle.emit("lcu-champ-select-state", champ_select_ui_state(tr));
}

/// Emit one assist suggestion. The frontend shows it with a one-click button;
/// the backend only acts on it by itself when the matching opt-in automation
/// (e.g. `auto_bench_execute`) is enabled.
fn emit_lcu_assist(app_handle: &tauri::AppHandle, payload: serde_json::Value) {
    let _ = app_handle.emit("lcu-assist", payload);
}

/// Every suggestion belongs to one champ select session: drop them all when it ends.
fn emit_assist_clear_all(app_handle: &tauri::AppHandle) {
    emit_lcu_assist(
        app_handle,
        serde_json::json!({ "kind": "clear", "target": "all" }),
    );
}

/// Reset the champ select tracker and tell the frontend the card is idle again.
async fn reset_champ_select_tracker(app_handle: &tauri::AppHandle, tracker_lock: &SharedTracker) {
    let mut tr = tracker_lock.lock().await;
    tr.reset();
    emit_champ_select_state(app_handle, &tr);
    emit_assist_clear_all(app_handle);
}

const TRAY_TOOLTIP_IDLE: &str = "ARAMPilot — 等待客戶端...";

/// Menu item handles the backend keeps in sync with the live `AppConfig`.
struct TrayHandles {
    status_lcu: MenuItem<Wry>,
    status_phase: MenuItem<Wry>,
    accept: CheckMenuItem<Wry>,
    card: CheckMenuItem<Wry>,
    bench: CheckMenuItem<Wry>,
    trade: CheckMenuItem<Wry>,
    chat: CheckMenuItem<Wry>,
    ff: CheckMenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

/// Mirror every automation switch into the tray check marks.
fn sync_tray_checks(app: &tauri::AppHandle, cfg: &AppConfig) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let _ = handles.accept.set_checked(cfg.auto_accept);
    let _ = handles.card.set_checked(cfg.aram_settings.auto_card_select);
    let _ = handles.bench.set_checked(cfg.aram_settings.auto_bench_swap);
    let _ = handles.trade.set_checked(cfg.aram_settings.auto_trade);
    let _ = handles.chat.set_checked(cfg.auto_chat_on_swap);
    let _ = handles.ff.set_checked(cfg.ff_reminder);
}

/// Translate a gameflow phase into the tray wording.
fn tray_phase_label(phase: Option<&str>) -> &str {
    match phase {
        Some("Lobby") => "大廳",
        Some("Matchmaking") => "配對中",
        Some("ReadyCheck") => "接受對戰",
        Some("ChampSelect") => "選角",
        Some("InProgress") => "遊戲中",
        Some("EndOfGame") => "結算",
        Some("None") | Some("") | None => "待機",
        Some(other) => other,
    }
}

/// Whether a queue ID belongs to ARAM: Mayhem (standard 2400, tournament 2410, custom 3270).
pub fn is_mayhem_queue(queue_id: Option<i32>) -> bool {
    matches!(queue_id, Some(2400 | 2410 | 3270))
}

/// Whether a queue ID belongs to ARAM (standard 450, clash 720/721, bot 860, custom 3200/3210/3220/3230).
pub fn is_aram_queue(queue_id: Option<i32>) -> bool {
    matches!(
        queue_id,
        Some(450 | 720 | 721 | 860 | 3200 | 3210 | 3220 | 3230)
    )
}

/// Refresh the tray status rows and the icon tooltip.
fn update_tray_status(
    app: &tauri::AppHandle,
    connected: bool,
    port: Option<u16>,
    phase: Option<&str>,
    queue_id: Option<i32>,
) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };

    let (lcu_text, phase_text) = if connected {
        (
            format!(
                "LCU：已連線 (Port {})",
                port.map(|p| p.to_string()).unwrap_or_default()
            ),
            format!(
                "狀態：{} · {}",
                tray_phase_label(phase),
                queue_mode_name(queue_id)
            ),
        )
    } else {
        (
            "LCU：等待客戶端...".to_string(),
            "狀態：等待連線".to_string(),
        )
    };

    let _ = handles.status_lcu.set_text(&lcu_text);
    let _ = handles.status_phase.set_text(&phase_text);
    let tooltip = format!(
        "ARAMPilot — {}",
        phase_text.strip_prefix("狀態：").unwrap_or(&phase_text)
    );
    let _ = handles.tray.set_tooltip(Some(&tooltip));
}

/// Bring the main window back from the tray.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Apply one `toggle_*` click: flip the setting, persist it, and mirror it everywhere.
async fn handle_tray_toggle(
    app: &tauri::AppHandle,
    config_lock: &SharedConfig,
    id: &str,
) {
    // Read-modify-write under the config write lock, so a UI save landing in
    // between is never overwritten with a stale copy.
    let mut live = config_lock.write().await;
    // The switch takes effect in memory even if the file write fails, so the
    // user can always turn automation off for this run.
    let cfg = &mut *live;

    // Both ARAM and Mayhem follow the tray toggle so the modes never drift apart.
    let (label, enabled) = match id {
        "toggle_accept" => {
            cfg.auto_accept = !cfg.auto_accept;
            ("自動接受對戰", cfg.auto_accept)
        }
        "toggle_card" => {
            let next = !cfg.aram_settings.auto_card_select;
            cfg.aram_settings.auto_card_select = next;
            cfg.mayhem_settings.auto_card_select = next;
            ("選卡建議", next)
        }
        "toggle_bench" => {
            let next = !cfg.aram_settings.auto_bench_swap;
            cfg.aram_settings.auto_bench_swap = next;
            cfg.mayhem_settings.auto_bench_swap = next;
            ("板凳建議", next)
        }
        "toggle_trade" => {
            let next = !cfg.aram_settings.auto_trade;
            cfg.aram_settings.auto_trade = next;
            cfg.mayhem_settings.auto_trade = next;
            ("換角建議", next)
        }
        "toggle_chat" => {
            cfg.auto_chat_on_swap = !cfg.auto_chat_on_swap;
            ("換角成功後自動發話", cfg.auto_chat_on_swap)
        }
        "toggle_ff" => {
            cfg.ff_reminder = !cfg.ff_reminder;
            ("8:00 安全投降提醒", cfg.ff_reminder)
        }
        _ => return,
    };

    // Write the file before releasing the config lock, so two writers can never
    // land on disk in the opposite order from memory.
    let snapshot = live.clone();
    let saved = ConfigManager::new().save(&snapshot);
    drop(live);
    if let Err(err) = saved {
        let _ = app.emit(
            "lcu-log",
            serde_json::json!({
                "kind": "err",
                "title": "系統匣切換未儲存",
                "reason": format!("{label} 本次執行已生效，但沒有寫入設定檔：{err}"),
            }),
        );
    }
    sync_tray_checks(app, &snapshot);
    let _ = app.emit("config-updated", &snapshot);
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "sys",
            "title": "系統匣快速切換",
            "reason": format!("{} → {}", label, if enabled { "開啟" } else { "關閉" }),
        }),
    );
}

#[tauri::command]
async fn get_connection_status(state: State<'_, SharedLcu>) -> Result<ConnectionStatus, String> {
    let auth = state.get_auth().await;
    Ok(ConnectionStatus {
        connected: auth.is_some(),
        port: auth.map(|a| a.port),
    })
}

#[tauri::command]
async fn get_champions(state: State<'_, SharedLcu>) -> Result<Vec<ChampionItem>, String> {
    state.fetch_champions().await
}

#[tauri::command]
async fn get_champion_mastery(
    state: State<'_, SharedLcu>,
) -> Result<Vec<lcu::ChampionMasteryItem>, String> {
    state.fetch_champion_mastery().await
}

#[tauri::command]
async fn get_current_queue_id(state: State<'_, SharedLcu>) -> Result<Option<i32>, String> {
    Ok(state.fetch_current_queue_id().await)
}

#[tauri::command]
async fn get_gameflow_phase(state: State<'_, SharedLcu>) -> Result<Option<String>, String> {
    Ok(state.fetch_gameflow_phase().await)
}

#[tauri::command]
async fn get_champ_select_session(
    state: State<'_, SharedLcu>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.fetch_champ_select_session().await.ok())
}

#[tauri::command]
async fn get_app_config(state: State<'_, SharedConfig>) -> Result<AppConfig, String> {
    Ok(state.read().await.clone())
}

/// `save_app_config` error. `kind` lets the frontend tell the outcomes apart
/// without matching on text; `message` is exactly what it logs.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SaveConfigError {
    /// The unreadable-config guard refused the write.
    LoadRefused { message: String },
    /// Serializing or writing the file failed.
    WriteFailed { message: String },
}

#[tauri::command]
async fn save_app_config(
    app: tauri::AppHandle,
    state: State<'_, SharedConfig>,
    new_config: AppConfig,
) -> Result<(), SaveConfigError> {
    let mut sanitized = new_config;
    sanitized.sanitize();
    // Hold the config write lock through the file write, so a tray toggle
    // racing this save can never leave an older copy on disk than in memory.
    // Memory follows the UI even when the write fails (reported to the UI), so
    // switching automation off always takes effect for this run.
    let mut live = state.write().await;
    let auto_start_changed = live.auto_start != sanitized.auto_start;
    *live = sanitized.clone();
    let saved = ConfigManager::new().save(&sanitized);
    // Saves fire every few hundred ms while dragging; only touch the Run key
    // when the switch itself flips. Requested under the lock so requests keep
    // the order of the config changes (the request never blocks on reg.exe).
    if auto_start_changed {
        config::sync_windows_auto_start(sanitized.auto_start);
    }
    drop(live);
    sync_tray_checks(&app, &sanitized);
    saved.map_err(|err| match err {
        SaveError::LoadRefused => SaveConfigError::LoadRefused {
            message: config::LOAD_FAILED_SAVE_REFUSED.to_string(),
        },
        SaveError::Write(message) => SaveConfigError::WriteFailed { message },
    })
}

#[tauri::command]
async fn get_active_account(state: State<'_, SharedAccount>) -> Result<Option<ActiveAccount>, String> {
    Ok(state.read().await.clone())
}

/// Snapshot the live config into `backups/` before a destructive edit (PK apply).
///
/// Returns the written path so the UI can name the backup in its log line.
#[tauri::command]
async fn backup_config_snapshot(
    state: State<'_, SharedConfig>,
    reason: String,
    stamp: Option<String>,
) -> Result<String, String> {
    let json = {
        let cfg = state.read().await;
        serde_json::to_string_pretty(&*cfg).map_err(|e| e.to_string())?
    };
    // The frontend sends its local time; fall back to the UTC stamp if it is malformed.
    let stamp = stamp
        .filter(|s| config::is_backup_stamp(s))
        .unwrap_or_else(config::backup_timestamp_now);
    let path = config::write_config_backup(
        &config::app_data_dir(),
        &config::backup_account_prefix(None),
        &stamp,
        &reason,
        &json,
    )?;
    Ok(path.display().to_string())
}

#[tauri::command]
async fn get_champ_select_ui_state(
    tracker: State<'_, SharedTracker>,
) -> Result<ChampSelectUiState, String> {
    let tr = tracker.lock().await;
    Ok(champ_select_ui_state(&tr))
}

/// Manually switch our summoner spells (D = `spell1_id`, F = `spell2_id`).
#[tauri::command]
async fn apply_summoner_spells(
    app: tauri::AppHandle,
    state: State<'_, SharedLcu>,
    tracker: State<'_, SharedTracker>,
    spell1_id: i32,
    spell2_id: i32,
    label: String,
) -> Result<(), String> {
    {
        let mut tr = tracker.lock().await;
        tr.last_applied_spells = Some((tr.my_champ_id, spell1_id, spell2_id));
        tr.record_bot_spells((spell1_id, spell2_id));
        // Lock in this choice so any in-flight WebSocket event never reverts it.
        tr.manual_spell_override = true;
    }
    state.set_summoner_spells(spell1_id, spell2_id).await?;
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "act",
            "title": "已切換召喚師技能",
            "reason": label,
        }),
    );
    Ok(())
}

/// The official client keeps a champion locked for 3s after it lands on the bench.
const BENCH_LOCK_SECS: f64 = 3.0;

/// Seconds still to wait before a bench swap for a champion may be sent.
///
/// The LCU bench swap endpoint does not enforce the 3s lock the official client
/// applies, so it is enforced locally: no request may go out for a champion
/// until `BENCH_LOCK_SECS` have passed since we first saw it on the bench. In
/// the FINALIZATION phase the phase clock is an additional lower bound.
fn bench_lock_remaining_secs(
    seen_elapsed: Option<f64>,
    phase: &str,
    phase_elapsed_secs: Option<f64>,
) -> f64 {
    // Never seen on the bench: be conservative and wait the full lock.
    let from_seen = seen_elapsed.map_or(BENCH_LOCK_SECS, |e| (BENCH_LOCK_SECS - e).max(0.0));
    let from_phase = if phase == "FINALIZATION" {
        phase_elapsed_secs
            .map(|e| (BENCH_LOCK_SECS - e).max(0.0))
            .unwrap_or(0.0)
    } else {
        0.0
    };
    from_seen.max(from_phase)
}

/// Record when every champion now on the bench was first seen there.
///
/// Runs on every champ select snapshot, independently of whether bench
/// suggestions or automation are enabled, so the lock clock is already running
/// by the time a swap is considered. A snapshot without `benchChampions` keeps
/// the existing clocks instead of clearing them.
fn update_bench_first_seen(tr: &mut ChampSelectSessionTracker, data: &serde_json::Value) {
    let Some(bench) = data.get("benchChampions").and_then(|v| v.as_array()) else {
        return;
    };
    let mut current: Vec<i32> = bench
        .iter()
        .filter_map(|b| b.get("championId").and_then(|v| v.as_i64()))
        .map(|cid| cid as i32)
        .filter(|&cid| cid > 0)
        .collect();
    current.sort_unstable();
    current.dedup();

    tr.bench_first_seen.retain(|cid, _| current.contains(cid));
    let now = Instant::now();
    for cid in current {
        tr.bench_first_seen.entry(cid).or_insert(now);
    }
}

/// Whether the last stretch of the bench lock can be served with one sleep and
/// no further session poll, saving one LCU round trip at the moment it unlocks.
///
/// Only in FINALIZATION, the last champ select phase, so no phase change can
/// move the lock while we sleep; and only when what is left fits in one poll.
/// `remaining_secs` is measured after the poll, so sleeping it out never sends
/// before the lock expires. Callers re-check the bench right before the POST.
fn can_finish_bench_lock_without_poll(phase: &str, remaining_secs: f64, poll_secs: f64) -> bool {
    phase == "FINALIZATION" && remaining_secs <= poll_secs
}

/// Champion IDs currently sitting on the bench in a champ select session.
fn session_bench_champion_ids(session: &serde_json::Value) -> Vec<i32> {
    session
        .get("benchChampions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("championId").and_then(|v| v.as_i64()))
                .map(|cid| cid as i32)
                .filter(|&cid| cid > 0)
                .collect()
        })
        .unwrap_or_default()
}

/// Block until the local bench lock for `champion_id` has expired.
///
/// Re-polls the session at most every 150ms to confirm the champion is still on
/// the bench, and returns `Err(reason)` as soon as it is gone (a teammate took
/// it) or champ select ended. A swap may be sent only after this returns
/// `Ok(())`. The final sleep may skip the last poll, so callers must confirm
/// the champion is still on the bench before sending.
async fn wait_for_bench_lock(
    lcu: &SharedLcu,
    tracker: &SharedTracker,
    champion_id: i32,
) -> Result<(), String> {
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);
    loop {
        let session = lcu
            .fetch_champ_select_session()
            .await
            .map_err(|_| "已離開選角".to_string())?;
        let on_bench = session_bench_champion_ids(&session).contains(&champion_id);

        let (seen_elapsed, phase, phase_elapsed_secs) = {
            let mut tr = tracker.lock().await;
            if on_bench {
                // Safety net: the snapshot normally records this, but a champion
                // we have never seen still has to unlock.
                tr.bench_first_seen
                    .entry(champion_id)
                    .or_insert_with(Instant::now);
            }
            let seen = tr
                .bench_first_seen
                .get(&champion_id)
                .map(|t| t.elapsed().as_secs_f64());
            (
                seen,
                champ_select_phase(&session).to_string(),
                phase_elapsed_ms(&session).map(|ms| ms as f64 / 1000.0),
            )
        };

        if !on_bench {
            return Err(format!("英雄 (ID: {}) 已離開板凳", champion_id));
        }

        let remaining = bench_lock_remaining_secs(seen_elapsed, &phase, phase_elapsed_secs);
        if remaining <= 0.0 {
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL.min(std::time::Duration::from_secs_f64(remaining))).await;
        if can_finish_bench_lock_without_poll(&phase, remaining, POLL_INTERVAL.as_secs_f64()) {
            return Ok(());
        }
    }
}

/// Give up on an automatic bench swap: release only what this task owns, then
/// say why in the log.
async fn abort_auto_bench_swap(
    app: &tauri::AppHandle,
    tracker: &SharedTracker,
    champion_id: i32,
    reason: &str,
) {
    let mut tr = tracker.lock().await;
    if tr.bench_retry_target == Some(champion_id) {
        tr.bench_retry_target = None;
    }
    if tr.bot_expected_champ == Some(champion_id) {
        tr.bot_expected_champ = None;
    }
    emit_champ_select_state(app, &tr);
    drop(tr);
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "err",
            "title": "自動換角已停止",
            "reason": reason,
        }),
    );
}

/// Opt-in automatic bench swap for one suggested champion.
///
/// Waits out the same local 3s bench lock the manual snipe honours, then sends
/// one swap at a time and retries at most 3 more times. Never sets
/// `manual_bench_hold`: an automatic swap is not a manual pick.
async fn run_auto_bench_swap(
    app: tauri::AppHandle,
    lcu: SharedLcu,
    tracker: SharedTracker,
    champion_id: i32,
    retry_ms: u64,
) {
    if let Err(reason) = wait_for_bench_lock(&lcu, &tracker, champion_id).await {
        abort_auto_bench_swap(&app, &tracker, champion_id, &reason).await;
        return;
    }

    // One initial attempt plus at most 3 retries.
    for attempt in 0..4u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(retry_ms)).await;
        }

        // A newer manual snipe or another auto swap may own the bench by now.
        {
            let mut tr = tracker.lock().await;
            if tr.bench_retry_target != Some(champion_id) {
                return;
            }
            if tr.manual_bench_hold.is_some() || tr.my_champ_id == champion_id {
                // Nothing left to do: a manual pick landed, or we already hold it.
                tr.bench_retry_target = None;
                if tr.bot_expected_champ == Some(champion_id) {
                    tr.bot_expected_champ = None;
                }
                emit_champ_select_state(&app, &tr);
                return;
            }
        }

        // A teammate may have taken it meanwhile: never POST for a champion that
        // is no longer on the bench.
        let Ok(session) = lcu.fetch_champ_select_session().await else {
            abort_auto_bench_swap(&app, &tracker, champion_id, "已離開選角").await;
            return;
        };
        if !session_bench_champion_ids(&session).contains(&champion_id) {
            abort_auto_bench_swap(
                &app,
                &tracker,
                champion_id,
                &format!("英雄 (ID: {}) 已離開板凳", champion_id),
            )
            .await;
            return;
        }

        // Mark the coming champion change as the bot's, not a manual pick.
        {
            let mut tr = tracker.lock().await;
            tr.bot_expected_champ = Some(champion_id);
        }
        if lcu.swap_bench(champion_id).await.is_ok() {
            let mut tr = tracker.lock().await;
            tr.last_bench_swap_time = Some(Instant::now());
            tr.bench_retry_target = None;
            tr.bench_suggest_target = None;
            // `bot_expected_champ` stays set so the WS event for this swap reads
            // as a bot swap and takes no manual hold.
            tr.last_bench_verdict = Some(format!("已自動換取板凳英雄 (ID: {})", champion_id));
            emit_champ_select_state(&app, &tr);
            drop(tr);
            emit_lcu_assist(
                &app,
                serde_json::json!({ "kind": "clear", "target": "bench" }),
            );
            let _ = app.emit(
                "lcu-log",
                serde_json::json!({
                    "kind": "act",
                    "title": "已自動換成板凳英雄",
                    "reason": format!("板凳解鎖滿 3 秒後自動換取英雄 (ID: {})", champion_id),
                }),
            );
            return;
        }

        // Clear the expectation so a later manual pick is still recognised.
        {
            let mut tr = tracker.lock().await;
            if tr.bot_expected_champ == Some(champion_id) {
                tr.bot_expected_champ = None;
            }
        }
    }

    abort_auto_bench_swap(
        &app,
        &tracker,
        champion_id,
        &format!("英雄 (ID: {}) 自動換角重試 4 次仍失敗，已停止", champion_id),
    )
    .await;
}

/// The champion our own cell currently holds in a champ select session.
fn session_my_champ_id(session: &serde_json::Value) -> i32 {
    let local_cell_id = session
        .get("localPlayerCellId")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if local_cell_id < 0 {
        return 0;
    }
    session
        .get("myTeam")
        .and_then(|v| v.as_array())
        .and_then(|team| {
            team.iter()
                .find(|m| m.get("cellId").and_then(|v| v.as_i64()) == Some(local_cell_id))
        })
        .and_then(|m| m.get("championId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32
}

/// Manual bench snipe from the overview card.
///
/// Waits out the 3s bench lock first (re-checking the session every 150ms), then
/// runs a bounded, strictly sequential retry loop (one HTTP request at a time,
/// `manual_snipe_interval_ms` apart, hard wall-clock and attempt caps). The
/// command itself always returns `Ok(())` so the UI never logs a spurious error
/// while the retry loop is doing its job.
#[tauri::command]
async fn swap_bench_champion(
    app: tauri::AppHandle,
    state: State<'_, SharedLcu>,
    tracker: State<'_, SharedTracker>,
    config: State<'_, SharedConfig>,
    champion_id: i32,
) -> Result<(), String> {
    if champion_id <= 0 {
        return Err("無效的英雄 ID".to_string());
    }
    let snipe_ms = config.read().await.manual_snipe_interval_ms;

    // One retry loop per target: a second click must not start a duplicate chain.
    let my_gen = {
        let mut tr = tracker.lock().await;
        if tr.manual_snipe_target == Some(champion_id) || tr.bench_retry_target == Some(champion_id) {
            return Ok(());
        }
        tr.manual_snipe_generation = tr.manual_snipe_generation.wrapping_add(1);
        tr.manual_snipe_target = Some(champion_id);
        tr.bench_retry_target = Some(champion_id);
        tr.bot_expected_champ = Some(champion_id);
        tr.manual_snipe_generation
    };

    // The UI shows `搶角中…` while `bench_retry_target` is set.
    {
        let tr = tracker.lock().await;
        emit_champ_select_state(&app, &tr);
    }
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "sys",
            "title": "手動搶角排程中",
            "reason": format!(
                "英雄 (ID: {}) 尚在板凳鎖定期，已啟動安全連點（先等滿 3 秒解鎖，之後每次等回報後間隔 {}ms，上限 3.2 秒）",
                champion_id, snipe_ms
            ),
        }),
    );

    let lcu_retry: SharedLcu = Arc::clone(&state);
    let tracker_retry: SharedTracker = Arc::clone(&tracker);
    let app_retry = app.clone();

    tauri::async_runtime::spawn(async move {
        // The 3s bench lock is enforced here: nothing is sent before it expires.
        // The wall-clock cap starts counting only after the wait, so a click at
        // second 0 still gets its full retry budget.
        if let Err(reason) = wait_for_bench_lock(&lcu_retry, &tracker_retry, champion_id).await {
            let mut tr = tracker_retry.lock().await;
            if tr.manual_snipe_generation == my_gen {
                tr.manual_snipe_target = None;
                if tr.bench_retry_target == Some(champion_id) {
                    tr.bench_retry_target = None;
                }
                if tr.bot_expected_champ == Some(champion_id) {
                    tr.bot_expected_champ = None;
                }
            }
            emit_champ_select_state(&app_retry, &tr);
            drop(tr);
            let _ = app_retry.emit(
                "lcu-log",
                serde_json::json!({
                    "kind": "err",
                    "title": "手動搶角已停止",
                    "reason": reason,
                }),
            );
            return;
        }

        let started_at = Instant::now();
        let max_elapsed = std::time::Duration::from_millis(3200);
        // Never exceed today's attempt rate: 24 attempts at the 120ms default.
        let max_attempts: u32 = 3200_u64.div_ceil(snipe_ms).max(1) as u32;
        let mut attempts: u32 = 0;

        while started_at.elapsed() < max_elapsed && attempts < max_attempts {
            // 1. Cheap in-memory guards: a newer snipe or a takeover ends this loop.
            {
                let tr = tracker_retry.lock().await;
                if tr.manual_snipe_generation != my_gen
                    || tr.manual_snipe_target != Some(champion_id)
                {
                    return;
                }
            }

            // 2. The WebSocket event may have already granted us the champion.
            let already_ours = tracker_retry.lock().await.my_champ_id == champion_id;
            if already_ours {
                let mut tr = tracker_retry.lock().await;
                tr.manual_bench_hold = Some(champion_id);
                tr.manual_snipe_target = None;
                tr.bench_retry_target = None;
                emit_champ_select_state(&app_retry, &tr);
                return;
            }

            // 3. Poll the session on the first and every 3rd attempt: verify the
            //    target is still on the bench (the lock was waited out above).
            if attempts.is_multiple_of(3) {
                let Ok(session) = lcu_retry.fetch_champ_select_session().await else {
                    // No longer in champ select.
                    break;
                };

                if session_my_champ_id(&session) == champion_id {
                    let mut tr = tracker_retry.lock().await;
                    tr.manual_bench_hold = Some(champion_id);
                    tr.manual_snipe_target = None;
                    tr.bench_retry_target = None;
                    emit_champ_select_state(&app_retry, &tr);
                    drop(tr);
                    let _ = app_retry.emit(
                        "lcu-log",
                        serde_json::json!({
                            "kind": "act",
                            "title": "已手動搶下板凳英雄",
                            "reason": format!(
                                "成功換取板凳英雄 (ID: {})，本局啟用手動保護",
                                champion_id
                            ),
                        }),
                    );
                    return;
                }

                if !session_bench_champion_ids(&session).contains(&champion_id) {
                    // A teammate took it, or it left the bench.
                    break;
                }
            }

            // 4. One request at a time: the previous call is awaited before sleeping.
            {
                let mut tr = tracker_retry.lock().await;
                tr.bot_expected_champ = Some(champion_id);
            }
            if lcu_retry.swap_bench(champion_id).await.is_ok() {
                let mut tr = tracker_retry.lock().await;
                tr.last_bench_swap_time = Some(Instant::now());
                tr.bench_retry_target = None;
                tr.manual_snipe_target = None;
                tr.manual_bench_hold = Some(champion_id);
                tr.bot_expected_champ = None;
                tr.last_bench_verdict =
                    Some(format!("已手動換取英雄 (ID: {})，本局啟用手動保護", champion_id));
                emit_champ_select_state(&app_retry, &tr);
                drop(tr);
                let _ = app_retry.emit(
                    "lcu-log",
                    serde_json::json!({
                        "kind": "act",
                        "title": "已手動搶下板凳英雄",
                        "reason": format!(
                            "板凳解鎖瞬間成功換取英雄 (ID: {})，本局啟用手動保護",
                            champion_id
                        ),
                    }),
                );
                return;
            }

            // Clear the expectation so a later manual pick is still recognised.
            {
                let mut tr = tracker_retry.lock().await;
                if tr.bot_expected_champ == Some(champion_id) {
                    tr.bot_expected_champ = None;
                }
            }

            attempts += 1;
            tokio::time::sleep(std::time::Duration::from_millis(snipe_ms)).await;
        }

        // Exhausted the caps without a swap: release the target and say why.
        let mut tr = tracker_retry.lock().await;
        if tr.manual_snipe_generation == my_gen {
            // Only release what this loop owns: an auto retry may own the target now.
            tr.manual_snipe_target = None;
            if tr.bench_retry_target == Some(champion_id) {
                tr.bench_retry_target = None;
            }
            if tr.bot_expected_champ == Some(champion_id) {
                tr.bot_expected_champ = None;
            }
        }
        emit_champ_select_state(&app_retry, &tr);
        drop(tr);
        let _ = app_retry.emit(
            "lcu-log",
            serde_json::json!({
                "kind": "err",
                "title": "手動搶角已停止",
                "reason": format!(
                    "英雄 (ID: {}) 鎖定未解開或已被隊友選走，已安全停止重試",
                    champion_id
                ),
            }),
        );
    });

    Ok(())
}

#[tauri::command]
async fn accept_trade_request(state: State<'_, SharedLcu>, trade_id: i64) -> Result<(), String> {
    state.accept_trade(trade_id).await
}

#[tauri::command]
async fn decline_trade_request(state: State<'_, SharedLcu>, trade_id: i64) -> Result<(), String> {
    state.decline_trade(trade_id).await
}

/// Chat text rules shared by `send_trade_chat` and its test.
fn validate_trade_chat_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("訊息不可為空".to_string());
    }
    if text.chars().count() > 200 {
        return Err("訊息不可超過 200 字".to_string());
    }
    Ok(())
}

/// Send the suggested champion card the player clicked on.
///
/// A click is a manual pick: it takes the manual hold, so an automatic bench
/// swap never replaces the champion the player just chose.
#[tauri::command]
async fn pick_champion_card(
    app: tauri::AppHandle,
    state: State<'_, SharedLcu>,
    tracker: State<'_, SharedTracker>,
    action_id: i64,
    champion_id: i32,
) -> Result<(), String> {
    if action_id < 0 {
        return Err("無效的選卡動作 ID".to_string());
    }
    if champion_id <= 0 {
        return Err("無效的英雄 ID".to_string());
    }
    let previous_hold = tracker.lock().await.begin_manual_card_pick(champion_id);
    let result = state.select_champion_card(action_id, champion_id).await;
    let mut tr = tracker.lock().await;
    if result.is_err() && tr.manual_bench_hold == Some(champion_id) {
        tr.manual_bench_hold = previous_hold;
    }
    emit_champ_select_state(&app, &tr);
    drop(tr);
    if result.is_ok() {
        emit_lcu_assist(
            &app,
            serde_json::json!({ "kind": "clear", "target": "bench" }),
        );
    }
    result
}

/// Send the suggested champ select chat message the player clicked on.
#[tauri::command]
async fn send_trade_chat(
    state: State<'_, SharedLcu>,
    chat_id: String,
    text: String,
) -> Result<(), String> {
    if chat_id.trim().is_empty() {
        return Err("無效的聊天室 ID".to_string());
    }
    validate_trade_chat_text(&text)?;
    state.send_chat_message(&chat_id, &text).await
}

#[tauri::command]
async fn dev_start_custom_test(state: State<'_, SharedLcu>) -> Result<(), String> {
    state.start_custom_test_session().await
}

#[tauri::command]
async fn dev_quit_champ_select(state: State<'_, SharedLcu>) -> Result<(), String> {
    state.quit_custom_champ_select().await
}

#[tauri::command]
fn minimize_window(window: tauri::Window) -> Result<(), String> {
    // Minimizing retreats to the system tray so background automation keeps running.
    window.hide().map_err(|e| e.to_string())
}

/// Zoom the webview to `scale` (clamped like `AppConfig::sanitize`) and report the
/// scale that was actually applied, so the slider can snap to it.
#[tauri::command]
fn set_ui_scale(window: tauri::WebviewWindow, scale: f64) -> Result<f64, String> {
    let scale = config::clamp_ui_scale(scale);
    window.set_zoom(scale).map_err(|e| e.to_string())?;
    Ok(scale)
}

/// Maximize the window, or restore it when it is already maximized. Returns the
/// new maximized state.
#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!maximized)
}

/// `exec-log.jsonl` rolls over to `exec-log.1.jsonl` past this size (one old file kept).
const EXEC_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Append one line to `path`, first rotating it to `<stem>.1.jsonl` once it
/// exceeds `max_bytes`, so the log never grows without bound.
fn append_line_rotating(path: &std::path::Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= max_bytes) {
        let rotated = path.with_extension("1.jsonl");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(path, &rotated)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{}", line)
}

#[tauri::command]
fn append_exec_log(time: String, kind: String, title: String, reason: String) {
    let dir = config::app_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let line = serde_json::json!({
        "time": time,
        "kind": kind,
        "title": title,
        "reason": reason,
    });
    let _ = append_line_rotating(&dir.join("exec-log.jsonl"), &line.to_string(), EXEC_LOG_MAX_BYTES);
}

#[tauri::command]
async fn close_window(window: tauri::Window, state: State<'_, SharedConfig>) -> Result<(), String> {
    if state.read().await.close_to_tray {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.app_handle().exit(0);
        Ok(())
    }
}

/// Build the tray icon, its native menu, and the click handlers.
fn build_tray(
    app: &mut tauri::App,
    initial_cfg: &AppConfig,
    config_lock: SharedConfig,
) -> tauri::Result<()> {
    let status_lcu =
        MenuItem::with_id(app, "status_lcu", "LCU：等待客戶端...", false, None::<&str>)?;
    let status_phase =
        MenuItem::with_id(app, "status_phase", "狀態：等待連線", false, None::<&str>)?;
    let sep_status = PredefinedMenuItem::separator(app)?;
    let accept = CheckMenuItem::with_id(
        app,
        "toggle_accept",
        "自動接受對戰",
        true,
        initial_cfg.auto_accept,
        None::<&str>,
    )?;
    let card = CheckMenuItem::with_id(
        app,
        "toggle_card",
        "選卡建議",
        true,
        initial_cfg.aram_settings.auto_card_select,
        None::<&str>,
    )?;
    let bench = CheckMenuItem::with_id(
        app,
        "toggle_bench",
        "板凳建議",
        true,
        initial_cfg.aram_settings.auto_bench_swap,
        None::<&str>,
    )?;
    let trade = CheckMenuItem::with_id(
        app,
        "toggle_trade",
        "換角建議",
        true,
        initial_cfg.aram_settings.auto_trade,
        None::<&str>,
    )?;
    let chat = CheckMenuItem::with_id(
        app,
        "toggle_chat",
        "換角成功後自動發話",
        true,
        initial_cfg.auto_chat_on_swap,
        None::<&str>,
    )?;
    let ff = CheckMenuItem::with_id(
        app,
        "toggle_ff",
        "8:00 安全投降提醒",
        true,
        initial_cfg.ff_reminder,
        None::<&str>,
    )?;
    let sep_actions = PredefinedMenuItem::separator(app)?;
    let action_show = MenuItem::with_id(app, "action_show", "開啟主視窗", true, None::<&str>)?;
    let action_restart =
        MenuItem::with_id(app, "action_restart", "重新啟動", true, None::<&str>)?;
    let action_quit = MenuItem::with_id(app, "action_quit", "結束程式", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_lcu,
            &status_phase,
            &sep_status,
            &accept,
            &card,
            &bench,
            &trade,
            &chat,
            &ff,
            &sep_actions,
            &action_show,
            &action_restart,
            &action_quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(TRAY_TOOLTIP_IDLE)
        .on_menu_event(move |app, event| {
            let id = event.id().0.clone();
            match id.as_str() {
                "action_show" => show_main_window(app),
                // Re-exec the current binary in place (tray stays, window restored).
                "action_restart" => {
                    // Start the replacement with the restart flag in its own
                    // environment (it waits for our instance port instead of
                    // waking us), then exit. If it cannot start, keep running.
                    let spawned = std::env::current_exe().and_then(|exe| {
                        std::process::Command::new(exe)
                            .args(std::env::args_os().skip(1))
                            .env(single_instance::RESTART_ENV, "1")
                            .spawn()
                    });
                    match spawned {
                        Ok(_) => app.exit(0),
                        Err(err) => eprintln!("restart failed: {err}"),
                    }
                }
                "action_quit" => app.exit(0),
                toggle if toggle.starts_with("toggle_") => {
                    let app = app.clone();
                    let config_lock = Arc::clone(&config_lock);
                    spawn(async move {
                        handle_tray_toggle(&app, &config_lock, &id).await;
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;

    app.manage(TrayHandles {
        status_lcu,
        status_phase,
        accept,
        card,
        bench,
        trade,
        chat,
        ff,
        tray,
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A release build has no console and aborts on panic: show why before closing.
    fatal::install_panic_dialog();
    // One-time: move the pre-rename data folder to its new name before anything
    // reads it, so the single-instance ports come from the final folder. A
    // failed rename keeps the legacy folder in use and is retried next start.
    if let Some(app_data) = std::env::var_os("APPDATA") {
        match config::migrate_data_dir(&std::path::PathBuf::from(app_data)) {
            config::DataDirMigration::Moved => {
                eprintln!("data migration: renamed the legacy data folder to ARAMPilot")
            }
            config::DataDirMigration::Failed(error) => {
                eprintln!("data migration: could not rename the legacy data folder: {error}")
            }
            config::DataDirMigration::NotNeeded => {}
        }
    }
    // One instance per data directory: a second launch shows the first window and exits.
    let instance = single_instance::acquire(&single_instance::ports_for(&config::app_data_dir()));
    if matches!(instance, single_instance::Instance::AlreadyRunning) {
        return;
    }
    // One-time: merge the per-account config files into `config.json` before
    // anything loads, so the app starts on the user's real settings and rankings.
    let migration = config::migrate_account_configs(&config::app_data_dir());
    if migration.ran {
        eprintln!(
            "config migration: merged per-account files into config.json ({} ranking saves imported)",
            migration.imported_saves
        );
    }
    if let Some(error) = migration.error.as_deref() {
        eprintln!("config migration: {error}");
    }
    let config_mgr = ConfigManager::new();
    let (initial_config, initial_load_failed) = config_mgr.load_checked();
    // Match the Run key to the restored setting: re-point it at this executable
    // in case the install moved, or clear one left behind by another account.
    // Defaults from an unreadable file must not delete the user's key.
    if !initial_load_failed {
        config::sync_windows_auto_start(initial_config.auto_start);
    }
    let initial_config_for_tray = initial_config.clone();
    let initial_ui_scale = initial_config.ui_scale;
    let shared_config: SharedConfig = Arc::new(RwLock::new(initial_config));
    let shared_account: SharedAccount = Arc::new(RwLock::new(None));

    let lcu_manager = Arc::new(LcuManager::new());
    let lcu_for_watcher = Arc::clone(&lcu_manager);
    let lcu_for_events = Arc::clone(&lcu_manager);
    let lcu_for_worker = Arc::clone(&lcu_manager);
    let lcu_for_status = Arc::clone(&lcu_manager);
    let config_for_worker = Arc::clone(&shared_config);
    let config_for_status = Arc::clone(&shared_config);
    let config_for_alert = Arc::clone(&shared_config);
    let config_for_tray = Arc::clone(&shared_config);
    let account_for_status = Arc::clone(&shared_account);
    let account_for_worker = Arc::clone(&shared_account);
    let config_for_close = Arc::clone(&shared_config);

    let live_poller = Arc::new(LiveGamePoller::new());
    let live_poller_for_events = Arc::clone(&live_poller);
    let live_poller_for_status = Arc::clone(&live_poller);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(lcu_manager)
        .manage(shared_config)
        .manage(shared_account)
        .manage(live_poller)
        .setup(move |app| {
            if let single_instance::Instance::Primary(listener, earlier) = instance {
                let handle = app.handle().clone();
                single_instance::serve(listener, earlier, move || show_main_window(&handle));
            }
            // Tray icon, its menu, and the two-way config sync handlers.
            build_tray(
                app,
                &initial_config_for_tray,
                Arc::clone(&config_for_tray),
            )?;

            // `--minimized` (used by the Windows Run key) starts hidden in the tray.
            let start_minimized = std::env::args().any(|arg| arg == "--minimized");
            if let Some(main_window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = main_window.set_icon(icon);
                }
                if start_minimized {
                    let _ = main_window.hide();
                }

                // Apply the saved display scale now that the webview exists.
                let _ = main_window.set_zoom(config::clamp_ui_scale(initial_ui_scale));

                // Closing the window retreats to the tray unless the user opted out.
                let window_for_close = main_window.clone();
                // Maximizing by snapping / Win+Up / double-click never goes through the
                // frontend, so the title bar button learns the state from here.
                let window_for_resize = main_window.clone();
                let last_maximized = Arc::new(std::sync::atomic::AtomicBool::new(
                    main_window.is_maximized().unwrap_or(false),
                ));
                main_window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let config_lock = Arc::clone(&config_for_close);
                        let window = window_for_close.clone();
                        spawn(async move {
                            if config_lock.read().await.close_to_tray {
                                let _ = window.hide();
                            } else {
                                window.app_handle().exit(0);
                            }
                        });
                    }
                    tauri::WindowEvent::Resized(_) => {
                        let maximized = window_for_resize.is_maximized().unwrap_or(false);
                        if last_maximized.swap(maximized, std::sync::atomic::Ordering::Relaxed)
                            != maximized
                        {
                            let _ = window_for_resize.emit("window-maximized", maximized);
                        }
                    }
                    _ => {}
                });
            }

            let app_handle = app.handle().clone();
            let mut status_rx = lcu_for_events.subscribe_status();
            let mut event_rx = lcu_for_events.subscribe_events();
            let mut alert_rx = live_poller_for_events.subscribe_alerts();
            // Start the watcher only now: a client already running at launch is
            // reported once, and a broadcast with no receiver yet would be lost.
            lcu_for_watcher.start_watcher();
            let tracker = Arc::new(tokio::sync::Mutex::new(ChampSelectSessionTracker::default()));
            // Shared with the `swap_bench_champion` / `get_champ_select_ui_state` commands.
            app.manage(Arc::clone(&tracker));
            let tracker_for_status = Arc::clone(&tracker);
            let rc_tracker = Arc::new(tokio::sync::Mutex::new(ReadyCheckTracker::default()));
            let rc_tracker_for_status = Arc::clone(&rc_tracker);

            // Background task: forward LCU connection status to frontend
            let app_h1 = app_handle.clone();
            spawn(async move {
                loop {
                    let status = match status_rx.recv().await {
                        Ok(s) => s,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    let _ = app_h1.emit("lcu-status", &status);

                    if status.connected {
                        // Show which account is logged in (the config is shared).
                        if !sync_active_account(&app_h1, &lcu_for_status, &account_for_status).await
                        {
                            retry_account_sync(
                                app_h1.clone(),
                                Arc::clone(&lcu_for_status),
                                Arc::clone(&account_for_status),
                            );
                        }

                        let phase = lcu_for_status.fetch_gameflow_phase().await;
                        let queue_id = lcu_for_status.fetch_current_queue_id().await;
                        update_tray_status(&app_h1, true, status.port, phase.as_deref(), queue_id);

                        match phase.as_deref() {
                            Some("ReadyCheck") => {
                                if let Some(rc_data) = lcu_for_status.fetch_ready_check().await {
                                    handle_ready_check_event(
                                        &rc_data,
                                        &app_h1,
                                        &lcu_for_status,
                                        &config_for_status,
                                        &rc_tracker_for_status,
                                    )
                                    .await;
                                }
                            }
                            Some("InProgress") => {
                                // A client that connects mid-game must still arm the reminder.
                                let cfg = config_for_status.read().await.clone();
                                start_ff_poller(&lcu_for_status, &live_poller_for_status, &cfg)
                                    .await;
                            }
                            Some("ChampSelect") => {
                                // A client that connects mid-champ-select evaluates the live session immediately.
                                if let Ok(session) =
                                    lcu_for_status.fetch_champ_select_session().await
                                {
                                    let synthetic = lcu::LcuEvent {
                                        uri: "/lol-champ-select/v1/session".to_string(),
                                        event_type: "Update".to_string(),
                                        data: session,
                                    };
                                    let _ = app_h1.emit("lcu-event", &synthetic);
                                    handle_champ_select_event(
                                        &synthetic,
                                        &app_h1,
                                        &lcu_for_status,
                                        &config_for_status,
                                        &tracker_for_status,
                                    )
                                    .await;
                                }
                            }
                            _ => {}
                        }
                    } else {
                        update_tray_status(&app_h1, false, None, None, None);
                        reset_champ_select_tracker(&app_h1, &tracker_for_status).await;
                        rc_tracker_for_status.lock().await.reset();
                        live_poller_for_status.stop_polling().await;
                        let cfg = config_for_status.read().await.clone();
                        if cfg.client_close_action == "exit" {
                            app_h1.exit(0);
                        }
                    }
                }
            });

            // Background task: forward FF reminders to frontend & copy /ff
            let app_h_alert = app_handle.clone();
            spawn(async move {
                loop {
                    let msg = match alert_rx.recv().await {
                        Ok(m) => m,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    let cfg = config_for_alert.read().await.clone();
                    if !(cfg.master_enabled && cfg.ff_reminder) {
                        continue;
                    }
                    if cfg.ff_copy_clipboard
                        && let Ok(mut clipboard) = arboard::Clipboard::new()
                    {
                        let _ = clipboard.set_text("/ff");
                    }
                    // The frontend logs this alert itself, so no duplicate `lcu-log`.
                    let _ = app_h_alert.emit("lcu-ff-alert", &msg);
                }
            });

            // Background task: forward LCU events and run ChampSelect / ReadyCheck state machine
            let app_h2 = app_handle.clone();
            let poller_for_gameflow = Arc::clone(&live_poller_for_events);
            spawn(async move {
                loop {
                    let event = match event_rx.recv().await {
                        Ok(ev) => ev,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    let _ = app_h2.emit("lcu-event", &event);

                    if event.uri == "/lol-matchmaking/v1/ready-check" {
                        handle_ready_check_event(
                            &event.data,
                            &app_h2,
                            &lcu_for_worker,
                            &config_for_worker,
                            &rc_tracker,
                        )
                        .await;
                    } else if event.uri == "/lol-champ-select/v1/session" {
                        handle_champ_select_event(
                            &event,
                            &app_h2,
                            &lcu_for_worker,
                            &config_for_worker,
                            &tracker,
                        )
                        .await;
                    } else if event.uri == "/lol-summoner/v1/current-summoner" {
                        // Account login / switch without an LCU reconnect (watcher
                        // sees no port/token change, so no status event fires).
                        let _ = sync_active_account(&app_h2, &lcu_for_worker, &account_for_worker)
                            .await;
                    } else if event.uri == "/lol-gameflow/v1/gameflow-phase" {
                        let phase = event.data.as_str().unwrap_or("");
                        if phase == "None" || phase == "Lobby" {
                            reset_champ_select_tracker(&app_h2, &tracker).await;
                        }
                        if phase != "ReadyCheck" {
                            rc_tracker.lock().await.reset();
                        } else if let Some(rc_data) = lcu_for_worker.fetch_ready_check().await {
                            handle_ready_check_event(
                                &rc_data,
                                &app_h2,
                                &lcu_for_worker,
                                &config_for_worker,
                                &rc_tracker,
                            )
                            .await;
                        }
                        let port = lcu_for_worker.get_auth().await.map(|auth| auth.port);
                        let queue_id = lcu_for_worker.fetch_current_queue_id().await;
                        update_tray_status(&app_h2, true, port, Some(phase), queue_id);
                        if phase == "InProgress" {
                            let cfg = config_for_worker.read().await.clone();
                            start_ff_poller(&lcu_for_worker, &poller_for_gameflow, &cfg).await;
                        } else {
                            // EndOfGame / PreEndOfGame / WaitingForStats / ... all end the game.
                            poller_for_gameflow.stop_polling().await;
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_status,
            get_champions,
            get_champion_mastery,
            get_current_queue_id,
            get_gameflow_phase,
            get_champ_select_session,
            get_champ_select_ui_state,
            apply_summoner_spells,
            get_app_config,
            save_app_config,
            get_active_account,
            backup_config_snapshot,
            swap_bench_champion,
            pick_champion_card,
            accept_trade_request,
            decline_trade_request,
            send_trade_chat,
            dev_start_custom_test,
            dev_quit_champ_select,
            minimize_window,
            close_window,
            set_ui_scale,
            toggle_maximize_window,
            append_exec_log
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            fatal::show_error(&fatal::startup_error_text(&error.to_string()));
            std::process::exit(1);
        });
}

/// Arm the live-game poller when the reminder is enabled for the current queue.
async fn start_ff_poller(lcu: &SharedLcu, poller: &Arc<LiveGamePoller>, cfg: &AppConfig) {
    if !(cfg.master_enabled && cfg.ff_reminder) {
        return;
    }
    let queue_id = lcu.fetch_current_queue_id().await;
    // Only run the 8:00 surrender reminder in ARAM or Mayhem (never in Practice Tool / Summoner's Rift).
    if !is_mayhem_queue(queue_id) && !is_aram_queue(queue_id) {
        return;
    }
    let seconds = (parse_ff_time(&cfg.ff_time_aram) - cfg.ff_lead_sec).max(0.0);
    Arc::clone(poller).start_polling(seconds, cfg.ff_cooldown_reminder);
}

#[derive(Default)]
struct ReadyCheckTracker {
    accepted_this_phase: bool,
    timer_running: bool,
    generation: u64,
}

impl ReadyCheckTracker {
    fn reset(&mut self) {
        self.accepted_this_phase = false;
        self.timer_running = false;
        self.generation = self.generation.wrapping_add(1);
    }
}

fn queue_mode_name(queue_id: Option<i32>) -> &'static str {
    if is_mayhem_queue(queue_id) {
        "Mayhem"
    } else if is_aram_queue(queue_id) {
        "ARAM"
    } else {
        "其他"
    }
}

/// Handle ReadyCheck events directly in the Rust backend so minimizing to the system
/// tray never suffers from WebView2 background timer throttling.
async fn handle_ready_check_event(
    data: &serde_json::Value,
    app_handle: &tauri::AppHandle,
    lcu: &SharedLcu,
    config_lock: &SharedConfig,
    rc_tracker_lock: &Arc<tokio::sync::Mutex<ReadyCheckTracker>>,
) {
    let state = data.get("state").and_then(|v| v.as_str()).unwrap_or("");
    let player_response = data
        .get("playerResponse")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !(state == "InProgress" && player_response == "None") {
        let mut rc = rc_tracker_lock.lock().await;
        rc.timer_running = false;
        rc.generation = rc.generation.wrapping_add(1);
        if state != "InProgress" {
            rc.accepted_this_phase = false;
        }
        return;
    }

    let cfg = config_lock.read().await.clone();
    if !(cfg.master_enabled && cfg.auto_accept) {
        return;
    }

    let my_gen = {
        let mut rc = rc_tracker_lock.lock().await;
        if rc.accepted_this_phase || rc.timer_running {
            return;
        }
        rc.timer_running = true;
        rc.generation = rc.generation.wrapping_add(1);
        rc.generation
    };

    // Check mode eligibility up-front so Practice Tool / Summoner's Rift never logs "準備自動接受".
    let check_started = Instant::now();
    let initial_queue_id = lcu.fetch_current_queue_id().await;
    let mode = queue_mode_name(initial_queue_id);
    let allowed = if cfg.accept_modes.is_empty() {
        mode == "ARAM" || mode == "Mayhem"
    } else {
        cfg.accept_modes.iter().any(|m| m == mode)
    };
    if !allowed {
        {
            let mut rc = rc_tracker_lock.lock().await;
            rc.accepted_this_phase = true;
            rc.timer_running = false;
        }
        let queue_desc = initial_queue_id
            .map(|q| {
                if q > 0 {
                    format!("（queue {}）", q)
                } else {
                    "（非大亂鬥／自訂或練習工具）".to_string()
                }
            })
            .unwrap_or_else(|| "（無法判定）".to_string());
        let _ = app_handle.emit(
            "lcu-log",
            serde_json::json!({
                "kind": "skip",
                "title": "略過自動接受對戰",
                "reason": format!("目前模式為 {}{}，未列入生效模式", mode, queue_desc),
            }),
        );
        return;
    }

    let configured_delay = cfg.accept_delay_sec.max(0.0);
    // In LCU `/lol-matchmaking/v1/ready-check`, `timer` counts UP from 0.0 to 12.0 seconds elapsed.
    let elapsed_timer_sec = data.get("timer").and_then(|v| v.as_f64());
    let safe_delay = match elapsed_timer_sec {
        Some(elapsed) if elapsed >= 0.0 => configured_delay.min((10.5 - elapsed).max(0.0)),
        _ => configured_delay,
    };
    // Subtract the time already spent querying queue_id so total latency matches configured_delay.
    let remaining_sleep = (safe_delay - check_started.elapsed().as_secs_f64()).max(0.0);

    let _ = app_handle.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "act",
            "title": "偵測到對戰確認！準備自動接受",
            "reason": format!("延遲 {:.1} 秒發送", safe_delay),
        }),
    );

    let app_h = app_handle.clone();
    let lcu_clone = Arc::clone(lcu);
    let config_clone = Arc::clone(config_lock);
    let rc_clone = Arc::clone(rc_tracker_lock);

    tauri::async_runtime::spawn(async move {
        if remaining_sleep > 0.0 {
            tokio::time::sleep(std::time::Duration::from_secs_f64(remaining_sleep)).await;
        }

        {
            let rc = rc_clone.lock().await;
            if rc.generation != my_gen || rc.accepted_this_phase {
                return;
            }
        }

        let cfg = config_clone.read().await.clone();
        if !(cfg.master_enabled && cfg.auto_accept) {
            rc_clone.lock().await.timer_running = false;
            return;
        }

        // If the client already moved past ReadyCheck (e.g. instant 1-player custom lobby transition),
        // silently stop instead of firing a stale POST that returns HTTP 500.
        if remaining_sleep > 0.0
            && lcu_clone.fetch_gameflow_phase().await.as_deref() != Some("ReadyCheck")
        {
            let mut rc = rc_clone.lock().await;
            rc.timer_running = false;
            return;
        }

        {
            let mut rc = rc_clone.lock().await;
            if rc.generation != my_gen || rc.accepted_this_phase {
                rc.timer_running = false;
                return;
            }
            rc.accepted_this_phase = true;
            rc.timer_running = false;
        }

        match lcu_clone.accept_ready_check().await {
            Ok(()) => {
                let _ = app_h.emit(
                    "lcu-log",
                    serde_json::json!({
                        "kind": "act",
                        "title": "已自動接受對戰",
                        "reason": "POST /lol-matchmaking/v1/ready-check/accept",
                    }),
                );
                let _ = app_h.emit("lcu-ready-accepted", ());
            }
            Err(e) => {
                // If ReadyCheck already transitioned to ChampSelect while our POST was in flight,
                // ignore the benign 500 error.
                if lcu_clone.fetch_gameflow_phase().await.as_deref() != Some("ReadyCheck") {
                    return;
                }
                let mut rc = rc_clone.lock().await;
                rc.accepted_this_phase = false;
                let _ = app_h.emit(
                    "lcu-log",
                    serde_json::json!({
                        "kind": "err",
                        "title": "自動接受對戰失敗",
                        "reason": e,
                    }),
                );
            }
        }
    });
}

/// Parse a `"MM:SS"` surrender reminder time into seconds (falls back to 8 minutes).
fn parse_ff_time(raw: &str) -> f64 {
    let mut parts = raw.split(':');
    let minutes = parts.next().and_then(|v| v.trim().parse::<f64>().ok());
    let seconds = parts.next().and_then(|v| v.trim().parse::<f64>().ok());
    match (minutes, seconds) {
        (Some(m), Some(s)) if m >= 0.0 && s >= 0.0 && parts.next().is_none() => m * 60.0 + s,
        _ => 480.0,
    }
}

/// Milliseconds since the Unix epoch, or `0` if the system clock is before it.
fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Remaining seconds in the current champ-select phase.
///
/// `adjustedTimeLeftInPhase` is a snapshot taken at `internalNowInEpochMs`, so the
/// elapsed time between the event and our processing must be subtracted. The `35`
/// fallback only applies when the timer payload is unusable.
fn remaining_phase_secs(data: &serde_json::Value) -> Option<i32> {
    let timer = data.get("timer")?;
    let total_ms = timer
        .get("totalTimeInPhase")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if total_ms <= 0 {
        return None;
    }
    let adjusted_ms = timer
        .get("adjustedTimeLeftInPhase")
        .and_then(|v| v.as_i64())?;

    let mut left_ms = adjusted_ms;
    if let Some(snapshot_ms) = timer.get("internalNowInEpochMs").and_then(|v| v.as_i64()) {
        let elapsed_ms = now_epoch_ms() - snapshot_ms;
        if elapsed_ms > 0 {
            left_ms = (adjusted_ms - elapsed_ms).max(0);
        }
    }

    Some((left_ms / 1000) as i32)
}

/// Milliseconds already spent in the current champ-select phase.
///
/// Riot's champ select runs in two phases: a 15s "reveal" phase (`BAN_PICK`) where
/// the offered cards are shown, and a 45s "finalization" phase where everybody
/// finishes their loadout. The bench becomes swappable for teammates 3 seconds
/// into the finalization phase, and a player's own unselected cards become
/// swappable 3 seconds after their own initial selection.
fn phase_elapsed_ms(data: &serde_json::Value) -> Option<i64> {
    let timer = data.get("timer")?;
    let total_ms = timer
        .get("totalTimeInPhase")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if total_ms <= 0 {
        return None;
    }
    let adjusted_ms = timer
        .get("adjustedTimeLeftInPhase")
        .and_then(|v| v.as_i64())?;

    let mut left_ms = adjusted_ms;
    if let Some(snapshot_ms) = timer.get("internalNowInEpochMs").and_then(|v| v.as_i64()) {
        let elapsed_ms = now_epoch_ms() - snapshot_ms;
        if elapsed_ms > 0 {
            left_ms = (adjusted_ms - elapsed_ms).max(0);
        }
    }

    Some(total_ms - left_ms)
}

/// The current champ-select phase name (`BAN_PICK` = reveal, `FINALIZATION` = 45s phase).
fn champ_select_phase(data: &serde_json::Value) -> &str {
    data.get("timer")
        .and_then(|t| t.get("phase"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

/// True when our pending pick action is still open and the player has not picked
/// a champion (or still holds the champion we saw before the delay) themselves.
fn is_card_pick_still_pending(
    session: &serde_json::Value,
    action_id: i64,
    local_cell_id: i64,
    initial_my_champ_id: i32,
) -> bool {
    let action_completed = session
        .get("actions")
        .and_then(|v| v.as_array())
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| g.as_array())
                .flatten()
                .any(|action| {
                    action.get("id").and_then(|v| v.as_i64()) == Some(action_id)
                        && action
                            .get("completed")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                })
        })
        .unwrap_or(true);
    if action_completed {
        return false;
    }

    let current_champ_id = session
        .get("myTeam")
        .and_then(|v| v.as_array())
        .and_then(|team| {
            team.iter()
                .find(|m| m.get("cellId").and_then(|v| v.as_i64()) == Some(local_cell_id))
        })
        .and_then(|m| m.get("championId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    current_champ_id == 0 || current_champ_id == initial_my_champ_id
}

async fn handle_champ_select_event(
    event: &lcu::LcuEvent,
    app_handle: &tauri::AppHandle,
    lcu: &SharedLcu,
    config_lock: &SharedConfig,
    tracker_lock: &Arc<tokio::sync::Mutex<ChampSelectSessionTracker>>,
) {
    if event.event_type == "Delete" {
        let mut tr = tracker_lock.lock().await;
        tr.reset();
        emit_champ_select_state(app_handle, &tr);
        emit_assist_clear_all(app_handle);
        return;
    }

    let config = config_lock.read().await.clone();
    if !config.master_enabled {
        return;
    }

    let data = &event.data;
    let local_cell_id = data
        .get("localPlayerCellId")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if local_cell_id < 0 {
        return;
    }

    // Identify my champion and current summoner spells on our cell
    let mut my_champ_id = 0;
    let mut current_client_spells: Option<(i32, i32)> = None;
    if let Some(my_team) = data.get("myTeam").and_then(|v| v.as_array()) {
        for member in my_team {
            if member.get("cellId").and_then(|v| v.as_i64()) == Some(local_cell_id) {
                my_champ_id = member
                    .get("championId")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                let s1 = member
                    .get("spell1Id")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                let s2 = member
                    .get("spell2Id")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as i32;
                if s1 > 0 && s2 > 0 {
                    current_client_spells = Some((s1, s2));
                }
                break;
            }
        }
    }

    let mut tr = tracker_lock.lock().await;
    tr.local_cell_id = local_cell_id;
    let old_champ_id = tr.my_champ_id;
    tr.my_champ_id = my_champ_id;

    // Our initial selection just happened: our own unselected offer cards unlock 3s later.
    if old_champ_id == 0 && my_champ_id != 0 {
        tr.our_pick_time = Some(Instant::now());
    }

    // Detect manual champion change: the player picked a champion themselves.
    // If the change matches what the bot was trying to acquire, it is a bot swap, not a manual pick.
    tr.observe_champion_change(old_champ_id, my_champ_id);

    // Resolve the queue id so ARAM (450) and Mayhem (2400) use their own profile/settings,
    // and non-ARAM modes (Practice Tool, Summoner's Rift, TFT, Arena) are strictly excluded!
    // Note: custom lobbies report `queueId: -1` in `/lol-champ-select/v1/session`, so ignore
    // `<= 0` here and let `fetch_current_queue_id` inspect gameflow/lobby `gameMode` & `mapId`.
    let mut queue_id = data
        .get("queueId")
        .and_then(|v| v.as_i64())
        .filter(|&v| v > 0)
        .map(|v| v as i32);
    if queue_id.is_none() {
        queue_id = tr.current_queue_id;
    }
    if queue_id.is_none() {
        queue_id = lcu.fetch_current_queue_id().await;
    }
    tr.current_queue_id = queue_id;

    let is_mayhem = is_mayhem_queue(queue_id);
    let is_aram = is_aram_queue(queue_id);
    if !is_mayhem && !is_aram {
        tr.last_bench_verdict = Some(
            "非 ARAM／Mayhem 模式（如練習工具／召喚峽谷），已停用選角與技能自動化".to_string(),
        );
        emit_champ_select_state(app_handle, &tr);
        return;
    }

    // Detect if the player manually changed their summoner spells inside the LoL client.
    if tr.observe_client_spells(current_client_spells)
        && let Some((s1, s2)) = current_client_spells
    {
        let _ = app_handle.emit(
            "lcu-log",
            serde_json::json!({
                "kind": "skip",
                "title": "偵測到手動調整召喚師技能",
                "reason": format!(
                    "玩家已手動變更為 D {} ＋ F {}，本局保留手動設定不再覆蓋",
                    engine::spell_name(s1),
                    engine::spell_name(s2)
                )
            }),
        );
    }

    // ARAM and Mayhem share one unified profile and settings, so the user never has to
    // switch modes or copy rankings between them.
    let profile = &config.aram_profile;
    let settings = &config.aram_settings;

    // Auto summoner spells: Flash on the preferred key + secondary spell
    // (per-champion memory first, mode default otherwise).
    // Never overwrite if the player manually changed spells in the client this session!
    if config.auto_summoner_spells && my_champ_id > 0 && !tr.manual_spell_override {
        // Memory off: resolve against no per-champion entries so the mode default wins.
        let memory: &[config::ChampionProfileItem] = if config.remember_champion_spells {
            profile
        } else {
            &[]
        };
        let (spell1_id, spell2_id, _secondary_id, is_custom) = engine::resolve_summoner_spells(
            my_champ_id,
            memory,
            settings,
            &config.primary_spell_key,
        );
        if tr.last_applied_spells != Some((my_champ_id, spell1_id, spell2_id)) {
            tr.last_applied_spells = Some((my_champ_id, spell1_id, spell2_id));
            tr.record_bot_spells((spell1_id, spell2_id));

            // Skip the PATCH when the client already shows exactly these spells.
            let already_set = current_client_spells == Some((spell1_id, spell2_id));

            if !already_set {
                match lcu.set_summoner_spells(spell1_id, spell2_id).await {
                    Ok(()) => {
                        let champ_name = profile
                            .iter()
                            .find(|c| c.id == my_champ_id)
                            .map(|c| c.name.clone())
                            .unwrap_or_else(|| format!("ID:{}", my_champ_id));
                        let _ = app_handle.emit(
                            "lcu-log",
                            serde_json::json!({
                                "kind": "act",
                                "title": "已自動帶上召喚師技能",
                                "reason": format!(
                                    "【{}】D {} ＋ F {}（{}）",
                                    champ_name,
                                    engine::spell_name(spell1_id),
                                    engine::spell_name(spell2_id),
                                    if is_custom { "英雄專屬記憶" } else { "模式預設" }
                                )
                            }),
                        );
                    }
                    Err(_) => {
                        // Retry on the next champ select event instead of giving up.
                        tr.last_applied_spells = None;
                    }
                }
            }
        }
    }

    // 0. Initial champion card selection (2~3 ARAM / Mayhem cards from /subset-champion-list)
    if !tr.card_picked {
        let mut pending_action_id: Option<i64> = None;
        if let Some(actions) = data.get("actions").and_then(|v| v.as_array()) {
            'action_groups: for group in actions {
                let Some(group_actions) = group.as_array() else {
                    continue;
                };
                for action in group_actions {
                    let actor_cell_id = action
                        .get("actorCellId")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(-1);
                    let action_type = action.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let completed = action
                        .get("completed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let action_id = action.get("id").and_then(|v| v.as_i64()).unwrap_or(-1);

                    if actor_cell_id == local_cell_id
                        && action_type == "pick"
                        && !completed
                        && action_id >= 0
                    {
                        pending_action_id = Some(action_id);
                        break 'action_groups;
                    }
                }
            }
        }

        // Read the 2~3 offered cards from `subsetChampionList` (if embedded) or LCU's
        // `/lol-lobby-team-builder/champ-select/v1/subset-champion-list`.
        // Never use `pickableChampionIds` (which is the player's entire owned roster).
        let mut candidate_cards: Vec<i32> = data
            .get("subsetChampionList")
            .map(lcu::parse_subset_champion_list)
            .unwrap_or_default();

        if candidate_cards.is_empty()
            && pending_action_id.is_some()
            && let Ok(fetched) = lcu.fetch_subset_champion_list().await
        {
            candidate_cards = fetched;
        }
        if !candidate_cards.is_empty() {
            tr.our_offer_cards = candidate_cards.clone();
        }

        if let Some(action_id) =
            pending_action_id.filter(|_| !candidate_cards.is_empty() && candidate_cards.len() <= 10)
        {
            let decision =
                ChampSelectRuleEngine::evaluate_cards(&candidate_cards, profile, settings);
            tr.card_picked = true;
            let _ = app_handle.emit("lcu-decision", &decision);

            match decision {
                CardDecision::Select { champ_id, reason } => {
                    // Assist mode: never pick for the player. Suggest the card and let
                    // the frontend send it back through `pick_champion_card`.
                    emit_lcu_assist(
                        app_handle,
                        serde_json::json!({
                            "kind": "card",
                            "champ_id": champ_id,
                            "action_id": action_id,
                            "reason": reason
                        }),
                    );
                    let _ = app_handle.emit(
                        "lcu-log",
                        serde_json::json!({
                            "kind": "sys",
                            "title": "建議選擇開局英雄卡",
                            "reason": reason
                        }),
                    );

                    // Opt-in automation: with `auto_card_execute` on, the backend
                    // picks the same card itself after the delay. The suggestion
                    // above stays, so the player can still pick another card.
                    if settings.auto_card_execute {
                        let lcu_auto: SharedLcu = Arc::clone(lcu);
                        let tracker_auto: SharedTracker = Arc::clone(tracker_lock);
                        let app_auto = app_handle.clone();
                        let delay = settings.card_select_delay_sec.max(0.0);
                        let initial_my_champ_id = my_champ_id;
                        let reason_auto = reason.clone();
                        spawn(async move {
                            if delay > 0.0 {
                                tokio::time::sleep(std::time::Duration::from_secs_f64(delay))
                                    .await;
                            }

                            // The player may have picked manually while we were waiting.
                            match lcu_auto.fetch_champ_select_session().await {
                                Ok(session) => {
                                    if !is_card_pick_still_pending(
                                        &session,
                                        action_id,
                                        local_cell_id,
                                        initial_my_champ_id,
                                    ) {
                                        let _ = app_auto.emit(
                                            "lcu-log",
                                            serde_json::json!({
                                                "kind": "skip",
                                                "title": "略過自動選卡",
                                                "reason": "玩家已手動選角，保留手動選擇"
                                            }),
                                        );
                                        return;
                                    }
                                }
                                Err(e) => {
                                    tracker_auto.lock().await.card_picked = false;
                                    let _ = app_auto.emit(
                                        "lcu-log",
                                        serde_json::json!({
                                            "kind": "err",
                                            "title": "無法確認選角狀態，取消自動選卡",
                                            "reason": format!("{}（{}）", reason_auto, e)
                                        }),
                                    );
                                    return;
                                }
                            }

                            {
                                tracker_auto.lock().await.bot_expected_champ = Some(champ_id);
                            }
                            match lcu_auto.select_champion_card(action_id, champ_id).await {
                                Ok(()) => {
                                    let _ = app_auto.emit(
                                        "lcu-log",
                                        serde_json::json!({
                                            "kind": "act",
                                            "title": "已自動選擇開局英雄卡",
                                            "reason": reason_auto
                                        }),
                                    );
                                }
                                Err(e) => {
                                    let mut tr_lock = tracker_auto.lock().await;
                                    tr_lock.card_picked = false;
                                    if tr_lock.bot_expected_champ == Some(champ_id) {
                                        tr_lock.bot_expected_champ = None;
                                    }
                                    let _ = app_auto.emit(
                                        "lcu-log",
                                        serde_json::json!({
                                            "kind": "err",
                                            "title": "開局選卡失敗",
                                            "reason": format!("{}（{}）", reason_auto, e)
                                        }),
                                    );
                                }
                            }
                        });
                    }
                }
                CardDecision::Skip { reason } => {
                    let _ = app_handle.emit(
                        "lcu-log",
                        serde_json::json!({
                            "kind": "skip",
                            "title": "略過開局選卡建議",
                            "reason": reason
                        }),
                    );
                }
            }
        }
    }

    // 1. Suggest a bench swap FIRST (prioritized over teammate trades so the
    //    player sees their own favorite before an incoming trade).
    //
    // The LCU bench swap endpoint does not enforce the 3s lock the official
    // client applies, so the app times it itself: record when each champion
    // first appeared on the bench before any suggestion or automation runs.
    update_bench_first_seen(&mut tr, data);

    let bench_enabled = data
        .get("benchEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // A manual overview snipe owns the bench until it lands or gives up.
    if bench_enabled && my_champ_id > 0 && tr.manual_snipe_target.is_none() {
        let now = Instant::now();
        let cooldown_ok = tr
            .last_bench_swap_time
            .is_none_or(|t| now.duration_since(t).as_secs() >= 3);

        if cooldown_ok {
            let mut bench_champs = Vec::new();
            if let Some(b_arr) = data.get("benchChampions").and_then(|v| v.as_array()) {
                for b in b_arr {
                    if let Some(cid) = b.get("championId").and_then(|v| v.as_i64()) {
                        bench_champs.push(cid as i32);
                    }
                }
            }

            let remaining_sec = remaining_phase_secs(data).filter(|&s| s >= 0).unwrap_or(35);
            let decision = ChampSelectRuleEngine::evaluate_bench(
                my_champ_id,
                &bench_champs,
                profile,
                settings,
                remaining_sec,
                tr.manual_bench_hold,
            );

            if let BenchDecision::Skip { reason } = &decision {
                tr.last_bench_verdict = Some(format!("略過板凳建議：{}", reason));
                // A bench skip is otherwise invisible in the log: record why the
                // rule engine declined to suggest a swap (manual hold, timing,
                // threshold, flags). Deduped per reason and throttled so event
                // bursts don't flood.
                let key = format!("{}|{}", my_champ_id, reason);
                let throttle_ok = tr
                    .last_bench_skip_log_time
                    .is_none_or(|t| t.elapsed().as_secs() >= 30);
                if tr.last_bench_skip_log_key.as_ref() != Some(&key) || throttle_ok {
                    tr.last_bench_skip_log_key = Some(key);
                    tr.last_bench_skip_log_time = Some(Instant::now());
                    let _ = app_handle.emit(
                        "lcu-log",
                        serde_json::json!({
                            "kind": "skip",
                            "title": "略過板凳建議",
                            "reason": reason
                        }),
                    );
                }
                // There is no suggestion any more: drop the bench assist in the UI.
                if tr.bench_suggest_target.take().is_some() {
                    emit_lcu_assist(
                        app_handle,
                        serde_json::json!({ "kind": "clear", "target": "bench" }),
                    );
                }
            }

            if let BenchDecision::Swap {
                target_champ_id,
                reason,
                ..
            } = decision
            {
                tr.last_bench_verdict = Some(format!("建議換成：{}", reason));
                // By default only suggest the swap: `swap_bench_champion` sends it
                // once the player clicks. With `auto_bench_execute` on, the backend
                // sends it itself after the 3s bench lock. Emit once per suggested
                // target so event bursts do not spam the UI.
                if tr.bench_suggest_target != Some(target_champ_id) {
                    tr.bench_suggest_target = Some(target_champ_id);
                    emit_lcu_assist(
                        app_handle,
                        serde_json::json!({
                            "kind": "bench",
                            "champ_id": target_champ_id,
                            "reason": reason.clone()
                        }),
                    );
                    let _ = app_handle.emit(
                        "lcu-log",
                        serde_json::json!({
                            "kind": "sys",
                            "title": "建議換成板凳英雄",
                            "reason": reason
                        }),
                    );
                }

                // Opt-in automation: send the swap ourselves, but only after the
                // local 3s bench lock has expired. Off by default, and never
                // while a manual snipe or another auto swap owns the bench.
                if settings.auto_bench_execute
                    && tr.manual_snipe_target.is_none()
                    && tr.bench_retry_target.is_none()
                {
                    tr.bench_retry_target = Some(target_champ_id);
                    emit_champ_select_state(app_handle, &tr);
                    let app_auto = app_handle.clone();
                    let lcu_auto: SharedLcu = Arc::clone(lcu);
                    let tracker_auto: SharedTracker = Arc::clone(tracker_lock);
                    let retry_ms = config.bench_retry_interval_ms;
                    spawn(async move {
                        run_auto_bench_swap(
                            app_auto,
                            lcu_auto,
                            tracker_auto,
                            target_champ_id,
                            retry_ms,
                        )
                        .await;
                    });
                }
            }
        }
    }

    // 2. Suggest a verdict for incoming trade requests from teammates
    if let Some(trades) = data.get("trades").and_then(|v| v.as_array()) {
        if !tr.allies_loaded {
            let (puuids, sids) = lcu.fetch_allied_friend_identifiers().await;
            // A single failed/empty fetch must not permanently disable friendship
            // classification: retry a few times — an empty result is usually a
            // transient LCU hiccup, not a friendless lobby. Stops after the cap.
            if !puuids.is_empty() || !sids.is_empty() || tr.allies_fetch_attempts >= 2 {
                tr.allied_puuids = puuids;
                tr.allied_summoner_ids = sids;
                tr.allies_loaded = true;
            } else {
                tr.allies_fetch_attempts += 1;
                tr.allied_puuids = puuids;
                tr.allied_summoner_ids = sids;
            }
        }

        for t in trades {
            let trade_id = t.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            let state = t.get("state").and_then(|v| v.as_str()).unwrap_or("");
            let cell_id = t.get("cellId").and_then(|v| v.as_i64()).unwrap_or(-1);
            if cell_id < 0 {
                continue;
            }

            let mut teammate_champ_id = 0;
            let mut teammate_puuid = String::new();
            let mut teammate_summoner_id = 0i64;
            if let Some(my_team) = data.get("myTeam").and_then(|v| v.as_array()) {
                for member in my_team {
                    if member.get("cellId").and_then(|v| v.as_i64()) == Some(cell_id) {
                        teammate_champ_id = member
                            .get("championId")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0) as i32;
                        teammate_puuid = member
                            .get("puuid")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        teammate_summoner_id = member
                            .get("summonerId")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        break;
                    }
                }
            }

            let is_friend_or_premade = (!teammate_puuid.is_empty()
                && tr.allied_puuids.contains(&teammate_puuid))
                || (teammate_summoner_id > 0
                    && tr.allied_summoner_ids.contains(&teammate_summoner_id));

            // Only process newly received trade requests ("RECEIVED").
            // Note: "AVAILABLE" means the slot is idle (no request sent yet) and must NOT be
            // treated as an incoming request or added to `processed_trade_ids`.
            let is_incoming = state == "RECEIVED";
            let is_outgoing = matches!(state, "SENT" | "PENDING" | "REQUESTED" | "OUTGOING");
            if !is_incoming {
                // If a previous trade on this slot resolved or was cancelled, allow future requests from the same cell.
                tr.processed_trade_ids.remove(&trade_id);
            }

            if is_incoming && !tr.processed_trade_ids.contains(&trade_id) {
                if teammate_champ_id > 0 && my_champ_id > 0 {
                    // Observability: who asked, and how we classified them, before
                    // the rule engine decides — so a "friend" rejected like a
                    // stranger is visible in the log (detection miss vs policy).
                    let friend_label = if is_friend_or_premade { "組排/好友" } else { "路人" };
                    let _ = app_handle.emit(
                        "lcu-log",
                        serde_json::json!({
                            "kind": "sys",
                            "title": "換角請求識別",
                            "reason": format!(
                                "cell{} {} · friend_policy={}",
                                cell_id, friend_label, settings.friend_trade_policy
                            )
                        }),
                    );

                    let decision = ChampSelectRuleEngine::evaluate_trade(
                        trade_id,
                        my_champ_id,
                        teammate_champ_id,
                        profile,
                        settings,
                        is_friend_or_premade,
                    );

                    let _ = app_handle.emit("lcu-decision", &decision);

                    match decision {
                        TradeDecision::Accept {
                            trade_id, reason, ..
                        } => {
                            tr.processed_trade_ids.insert(trade_id);
                            tr.last_trade_verdict = Some(format!("建議同意換角：{}", reason));
                            // Assist mode: never accept for the player. The frontend
                            // shows the suggestion and `accept_trade_request` sends it.
                            // Remember the pair so the chat suggestion can fire once the
                            // accepted swap actually lands.
                            if config.chat_on_accept_teammate {
                                tr.swap_confirmed_chat_pending =
                                    Some((my_champ_id, teammate_champ_id));
                            }
                            emit_lcu_assist(
                                app_handle,
                                serde_json::json!({
                                    "kind": "trade",
                                    "trade_id": trade_id,
                                    "verdict": "accept",
                                    "reason": reason
                                }),
                            );
                            let _ = app_handle.emit(
                                "lcu-log",
                                serde_json::json!({
                                    "kind": "sys",
                                    "title": "建議同意隊友換角",
                                    "reason": reason
                                }),
                            );
                        }
                        TradeDecision::Reject {
                            trade_id, reason, ..
                        } => {
                            tr.processed_trade_ids.insert(trade_id);
                            tr.last_trade_verdict = Some(format!("建議拒絕換角：{}", reason));
                            // Assist mode: only suggest; `decline_trade_request` sends it.
                            emit_lcu_assist(
                                app_handle,
                                serde_json::json!({
                                    "kind": "trade",
                                    "trade_id": trade_id,
                                    "verdict": "reject",
                                    "reason": reason
                                }),
                            );
                            let _ = app_handle.emit(
                                "lcu-log",
                                serde_json::json!({
                                    "kind": "sys",
                                    "title": "建議拒絕隊友換角",
                                    "reason": reason
                                }),
                            );
                        }
                        TradeDecision::Skip { reason, .. } => {
                            tr.processed_trade_ids.insert(trade_id);
                            tr.last_trade_verdict = Some(format!("由你手動決定：{}", reason));
                            let _ = app_handle.emit(
                                "lcu-log",
                                serde_json::json!({
                                    "kind": "skip",
                                    "title": "隊友發起換角請求",
                                    "reason": reason
                                }),
                            );
                        }
                    }
                }
            } else if is_outgoing
                && config.chat_on_teammate_accept_mine
                && my_champ_id > 0
                && teammate_champ_id > 0
                && teammate_champ_id != my_champ_id
            {
                // Remember what a successful trade would leave us holding.
                tr.sent_trade_chat_pending = Some((my_champ_id, teammate_champ_id));
            }
        }
    }

    // 3. Suggest a friendly thank-you chat once a swap actually landed
    if my_champ_id != 0 && my_champ_id != old_champ_id {
        let mut pending_chat: Option<(i32, i32)> = None;

        if let Some((old_id, new_id)) = tr.swap_confirmed_chat_pending
            && config.chat_on_accept_teammate
            && new_id == my_champ_id
            && old_id != my_champ_id
        {
            tr.swap_confirmed_chat_pending = None;
            pending_chat = Some((old_id, new_id));
        }
        if pending_chat.is_none()
            && let Some((old_id, new_id)) = tr.sent_trade_chat_pending
            && config.chat_on_teammate_accept_mine
            && new_id == my_champ_id
            && old_id != my_champ_id
        {
            tr.sent_trade_chat_pending = None;
            pending_chat = Some((old_id, new_id));
        }

        if let Some((old_id, new_id)) = pending_chat
            && config.auto_chat_on_swap
            && !config.chat_messages.is_empty()
        {
            let msg_index = now_epoch_ms() as usize % config.chat_messages.len();
            let msg_template = &config.chat_messages[msg_index];
            let old_name = profile
                .iter()
                .find(|c| c.id == old_id)
                .map(|c| c.name.as_str())
                .unwrap_or("原本英雄");
            let new_name = profile
                .iter()
                .find(|c| c.id == new_id)
                .map(|c| c.name.as_str())
                .unwrap_or("新英雄");
            let formatted = msg_template
                .replace("{old}", old_name)
                .replace("{new}", new_name);

            // Find championSelect chat conversation
            let chat_id = data
                .get("chatDetails")
                .and_then(|v| v.get("multiUserChatId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !chat_id.is_empty() {
                // Assist mode: never post the message for the player. The frontend
                // shows it and `send_trade_chat` sends it on click.
                emit_lcu_assist(
                    app_handle,
                    serde_json::json!({
                        "kind": "chat",
                        "chat_id": chat_id,
                        "text": formatted.clone()
                    }),
                );
                let _ = app_handle.emit(
                    "lcu-log",
                    serde_json::json!({
                        "kind": "sys",
                        "title": "建議發送選角室訊息",
                        "reason": formatted
                    }),
                );
            }
        }
    }

    // Publish the backend verdicts so the overview card never guesses.
    emit_champ_select_state(app_handle, &tr);
}

#[cfg(test)]
mod tests {
    use super::{
        SaveConfigError, append_line_rotating, bench_lock_remaining_secs,
        can_finish_bench_lock_without_poll, champ_select_phase, is_card_pick_still_pending,
        now_epoch_ms, parse_ff_time, phase_elapsed_ms, remaining_phase_secs, session_my_champ_id,
        validate_trade_chat_text,
    };
    use crate::config;
    use serde_json::json;

    #[test]
    fn test_save_config_error_serializes_kind_and_message() {
        let refused = serde_json::to_value(SaveConfigError::LoadRefused {
            message: config::LOAD_FAILED_SAVE_REFUSED.to_string(),
        })
        .unwrap();
        assert_eq!(refused["kind"], "loadRefused");
        assert_eq!(refused["message"], config::LOAD_FAILED_SAVE_REFUSED);

        let failed = serde_json::to_value(SaveConfigError::WriteFailed {
            message: "access denied".to_string(),
        })
        .unwrap();
        assert_eq!(failed["kind"], "writeFailed");
        assert_eq!(failed["message"], "access denied");
    }

    #[test]
    fn test_exec_log_rotates_past_size_limit() {
        let dir = std::env::temp_dir().join(format!("lolafk-execlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("exec-log.jsonl");
        append_line_rotating(&path, "aaaaaaaaaa", 16).unwrap();
        append_line_rotating(&path, "bbbbbbbbbb", 16).unwrap();
        // 22 bytes now >= 16: the next append rotates first.
        append_line_rotating(&path, "cccccccccc", 16).unwrap();
        let rotated = std::fs::read_to_string(dir.join("exec-log.1.jsonl")).unwrap();
        let current = std::fs::read_to_string(&path).unwrap();
        assert_eq!(rotated.lines().collect::<Vec<_>>(), vec!["aaaaaaaaaa", "bbbbbbbbbb"]);
        assert_eq!(current.lines().collect::<Vec<_>>(), vec!["cccccccccc"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_phase_elapsed_ms_counts_from_phase_start() {
        let now_ms = now_epoch_ms();
        // 45s phase, 40s remaining => 5s elapsed
        let data = json!({
            "timer": {
                "phase": "FINALIZATION",
                "totalTimeInPhase": 45000,
                "adjustedTimeLeftInPhase": 40000,
                "internalNowInEpochMs": now_ms
            }
        });
        let elapsed = phase_elapsed_ms(&data).expect("timer payload is usable");
        assert!((4900..=5000).contains(&elapsed), "got {} ms", elapsed);
    }

    #[test]
    fn test_champ_select_phase_detection() {
        let finalization = json!({
            "timer": { "phase": "FINALIZATION", "totalTimeInPhase": 45000, "adjustedTimeLeftInPhase": 30000 }
        });
        assert_eq!(champ_select_phase(&finalization), "FINALIZATION");

        let reveal = json!({
            "timer": { "phase": "BAN_PICK", "totalTimeInPhase": 15000, "adjustedTimeLeftInPhase": 12000 }
        });
        assert_eq!(champ_select_phase(&reveal), "BAN_PICK");
    }

    #[test]
    fn test_parse_ff_time_mm_ss() {
        assert_eq!(parse_ff_time("08:00"), 480.0);
        assert_eq!(parse_ff_time("05:30"), 330.0);
        assert_eq!(parse_ff_time(""), 480.0);
        assert_eq!(parse_ff_time("not-a-time"), 480.0);
        assert_eq!(parse_ff_time("08:00:00"), 480.0);
    }

    #[test]
    fn test_remaining_phase_secs_subtracts_elapsed_time() {
        let now_ms = now_epoch_ms();
        let data = json!({
            "timer": {
                "adjustedTimeLeftInPhase": 35000,
                "totalTimeInPhase": 30000,
                "internalNowInEpochMs": now_ms - 2000
            }
        });

        let secs = remaining_phase_secs(&data).expect("timer payload is usable");
        assert!((32..=33).contains(&secs), "got {} seconds", secs);
    }

    #[test]
    fn test_remaining_phase_secs_falls_back_only_when_unusable() {
        assert_eq!(remaining_phase_secs(&json!({})), None);
        assert_eq!(
            remaining_phase_secs(&json!({
                "timer": { "adjustedTimeLeftInPhase": 5000, "totalTimeInPhase": 0 }
            })),
            None
        );

        // 0 seconds is a real value and must not become the 35s fallback.
        let zero_left = json!({
            "timer": { "adjustedTimeLeftInPhase": 0, "totalTimeInPhase": 30000 }
        });
        assert_eq!(
            remaining_phase_secs(&zero_left).filter(|&s| s >= 0),
            Some(0)
        );
    }

    #[test]
    fn test_is_card_pick_still_pending() {
        let session = json!({
            "actions": [[{ "id": 7, "completed": false }]],
            "myTeam": [{ "cellId": 2, "championId": 0 }]
        });
        assert!(is_card_pick_still_pending(&session, 7, 2, 0));

        // Player picked manually while we were sleeping.
        let manual_pick = json!({
            "actions": [[{ "id": 7, "completed": false }]],
            "myTeam": [{ "cellId": 2, "championId": 103 }]
        });
        assert!(!is_card_pick_still_pending(&manual_pick, 7, 2, 0));

        // Action already completed (e.g. by us or the client).
        let completed = json!({
            "actions": [[{ "id": 7, "completed": true }]],
            "myTeam": [{ "cellId": 2, "championId": 0 }]
        });
        assert!(!is_card_pick_still_pending(&completed, 7, 2, 0));

        // Session without action data is treated as not pending.
        assert!(!is_card_pick_still_pending(&json!({}), 7, 2, 0));
    }

    #[test]
    fn test_validate_trade_chat_text() {
        assert!(validate_trade_chat_text("謝啦！{new} 交給我").is_ok());
        assert!(validate_trade_chat_text("   ").is_err());
        assert!(validate_trade_chat_text("").is_err());
        // 200 characters pass, 201 do not.
        assert!(validate_trade_chat_text(&"字".repeat(200)).is_ok());
        assert!(validate_trade_chat_text(&"字".repeat(201)).is_err());
    }

    #[test]
    fn test_session_my_champ_id_reads_our_cell() {
        let session = json!({
            "localPlayerCellId": 3,
            "myTeam": [
                { "cellId": 1, "championId": 68 },
                { "cellId": 3, "championId": 145 }
            ]
        });
        assert_eq!(session_my_champ_id(&session), 145);
        assert_eq!(session_my_champ_id(&json!({})), 0);
    }

    #[test]
    fn test_bench_lock_remaining_secs_honours_the_local_three_second_lock() {
        // A champion that just landed on the bench stays locked.
        assert!(bench_lock_remaining_secs(Some(2.9), "BAN_PICK", None) > 0.0);
        // The full lock is served.
        assert_eq!(bench_lock_remaining_secs(Some(3.0), "BAN_PICK", None), 0.0);
        // Never seen: be conservative and wait the whole lock.
        assert_eq!(bench_lock_remaining_secs(None, "BAN_PICK", None), 3.0);
        // FINALIZATION keeps the phase clock as a lower bound: seen 10s ago but
        // the phase only started 1s ago => 2s left.
        let remaining = bench_lock_remaining_secs(Some(10.0), "FINALIZATION", Some(1.0));
        assert!((1.999..=2.001).contains(&remaining), "got {}", remaining);
        // Both terms satisfied => nothing left to wait for.
        assert_eq!(
            bench_lock_remaining_secs(Some(10.0), "FINALIZATION", Some(5.0)),
            0.0
        );
    }

    #[test]
    fn test_bench_lock_skips_the_last_poll_only_when_it_cannot_send_early() {
        // FINALIZATION with less than one poll left: sleep it out, no extra poll.
        let finish = |phase, remaining| can_finish_bench_lock_without_poll(phase, remaining, 0.15);
        assert!(finish("FINALIZATION", 0.1));
        assert!(finish("FINALIZATION", 0.15));
        // More than one poll left: keep polling so a teammate's pick is noticed.
        assert!(!finish("FINALIZATION", 0.2));
        // BAN_PICK can still turn into FINALIZATION, whose phase clock adds a
        // fresh 3s lower bound, so the next poll must recompute the lock.
        assert!(!finish("BAN_PICK", 0.1));
        assert!(!finish("", 0.1));
        // Sleeping the computed remainder always reaches the full 3s lock.
        let seen = 2.9;
        let remaining = bench_lock_remaining_secs(Some(seen), "FINALIZATION", Some(10.0));
        assert!(seen + remaining >= 3.0);
    }
}
