//! Bench swaps: the local bench lock, the opt-in auto swap and the overview snipe.
//! Who owns the bench at any moment is `engine::BenchJob`; this module drives it.

use super::*;

/// The official client keeps a champion locked for 3s after it lands on the bench.
pub(crate) const BENCH_LOCK_SECS: f64 = 3.0;
/// LCU answers 204 to bench swaps early in BAN_PICK but applies none of them.
/// Measured 2026-11-17/18 from the gameflow ChampSelect event: all 7 ignored
/// swaps went out at +4..+14 s, every applied one at +15 s or later.
pub(crate) const BENCH_OPENING_LOCK_SECS: f64 = 15.0;

/// Seconds still to wait before a bench swap for a champion may be sent.
///
/// The LCU bench swap endpoint does not enforce the 3s lock the official client
/// applies, so it is enforced locally: no request may go out for a champion
/// until `BENCH_LOCK_SECS` have passed since we first saw it on the bench. The
/// phase clock is an additional lower bound: `BENCH_LOCK_SECS` into
/// FINALIZATION and `BENCH_OPENING_LOCK_SECS` into BAN_PICK.
pub(crate) fn bench_lock_remaining_secs(
    seen_elapsed: Option<f64>,
    phase: &str,
    phase_elapsed_secs: Option<f64>,
) -> f64 {
    // Never seen on the bench: be conservative and wait the full lock.
    let from_seen = seen_elapsed.map_or(BENCH_LOCK_SECS, |e| (BENCH_LOCK_SECS - e).max(0.0));
    let phase_floor = match phase {
        "FINALIZATION" => BENCH_LOCK_SECS,
        "BAN_PICK" => BENCH_OPENING_LOCK_SECS,
        _ => 0.0,
    };
    let from_phase = phase_elapsed_secs
        .map(|e| (phase_floor - e).max(0.0))
        .unwrap_or(0.0);
    from_seen.max(from_phase)
}

/// Log what really happened to an auto bench swap once the session shows it.
pub(crate) fn log_bench_swap_outcome(
    app_handle: &tauri::AppHandle,
    profile: &[config::ChampionProfileItem],
    outcome: engine::BenchSwapOutcome,
) {
    let name_of = |id: i32| {
        profile
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| format!("ID:{}", id))
    };
    let (kind, title, reason) = match outcome {
        engine::BenchSwapOutcome::Landed(p) => (
            "act",
            "已自動換成板凳英雄",
            if p.ignored_sends == 0 {
                format!(
                    "已換到【{}】，板凳解鎖後 {} ms 確認到手（第 {} 次嘗試）",
                    name_of(p.champ_id),
                    p.unlocked_at.elapsed().as_millis(),
                    p.attempt + 1
                )
            } else {
                format!(
                    "已換到【{}】，板凳解鎖後 {} ms 確認到手（前 {} 次請求 LCU 有接受但沒換到）",
                    name_of(p.champ_id),
                    p.unlocked_at.elapsed().as_millis(),
                    p.ignored_sends
                )
            },
        ),
        engine::BenchSwapOutcome::Lost(p) => (
            "skip",
            "沒換到板凳英雄",
            format!(
                "【{}】被隊友先換走，改找下一個順位（板凳解鎖後 {} ms 確認）",
                name_of(p.champ_id),
                p.unlocked_at.elapsed().as_millis()
            ),
        ),
    };
    let _ = app_handle.emit(
        "lcu-log",
        serde_json::json!({ "kind": kind, "title": title, "reason": reason }),
    );
}

/// Record when every champion now on the bench was first seen there.
///
/// Runs on every champ select snapshot, independently of whether bench
/// suggestions or automation are enabled, so the lock clock is already running
/// by the time a swap is considered. A snapshot without `benchChampions` keeps
/// the existing clocks instead of clearing them.
pub(crate) fn update_bench_first_seen(tr: &mut ChampSelectSessionTracker, data: &serde_json::Value) {
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
/// A phase change is what could move the lock while we sleep (FINALIZATION adds
/// a fresh 3s lower bound from its start), so this holds in FINALIZATION, the
/// last phase, or earlier when the phase clock still has more than
/// `PHASE_END_MARGIN_SECS` beyond the unlock; and only when what is left fits
/// in one poll. `remaining_secs` is measured after the poll, so sleeping it out
/// never sends before the lock expires. Callers re-check the bench right before
/// the POST.
pub(crate) fn can_finish_bench_lock_without_poll(
    phase: &str,
    remaining_secs: f64,
    poll_secs: f64,
    phase_left_secs: Option<f64>,
) -> bool {
    const PHASE_END_MARGIN_SECS: f64 = 0.5;
    let phase_stays = phase == "FINALIZATION"
        || phase_left_secs.is_some_and(|left| left > remaining_secs + PHASE_END_MARGIN_SECS);
    phase_stays && remaining_secs <= poll_secs
}

/// Seconds left in the current champ-select phase, from the session timer.
pub(crate) fn phase_left_secs(data: &serde_json::Value) -> Option<f64> {
    let total_ms = data
        .get("timer")?
        .get("totalTimeInPhase")
        .and_then(|v| v.as_i64())?;
    let elapsed_ms = phase_elapsed_ms(data)?;
    Some((total_ms - elapsed_ms) as f64 / 1000.0)
}

/// Champion IDs currently sitting on the bench in a champ select session.
pub(crate) fn session_bench_champion_ids(session: &serde_json::Value) -> Vec<i32> {
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
/// `Ok(())`. The final sleep may skip the last poll; callers POST immediately
/// and verify the bench only if that POST fails.
/// Why waiting out the bench lock ended without a swap.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum BenchWaitError {
    /// The champion left the bench: a teammate took it. Not an error.
    LeftBench,
    LeftChampSelect,
    /// A better suggestion took over this auto swap before it was sent.
    Retargeted,
}

pub(crate) async fn wait_for_bench_lock(
    lcu: &SharedLcu,
    tracker: &SharedTracker,
    champion_id: i32,
    token: u64,
) -> Result<(), BenchWaitError> {
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);
    loop {
        let session = lcu
            .fetch_champ_select_session()
            .await
            .map_err(|_| BenchWaitError::LeftChampSelect)?;
        let on_bench = session_bench_champion_ids(&session).contains(&champion_id);

        let phase_left = phase_left_secs(&session);
        let (seen_elapsed, phase, phase_elapsed_secs) = {
            let mut tr = tracker.lock().await;
            if !tr.bench_job.owned_by(token) {
                return Err(BenchWaitError::Retargeted);
            }
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
            return Err(BenchWaitError::LeftBench);
        }

        let remaining = bench_lock_remaining_secs(seen_elapsed, &phase, phase_elapsed_secs);
        if remaining <= 0.0 {
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL.min(std::time::Duration::from_secs_f64(remaining))).await;
        if can_finish_bench_lock_without_poll(
            &phase,
            remaining,
            POLL_INTERVAL.as_secs_f64(),
            phase_left,
        ) {
            return Ok(());
        }
    }
}

/// Diagnostic log for bench automation; titles share one prefix so they are easy
/// to filter (and to drop once the bench timing questions are settled).
pub(crate) fn emit_bench_diag(app: &tauri::AppHandle, title: &str, reason: String) {
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "sys",
            "title": format!("板凳診斷：{}", title),
            "reason": reason,
        }),
    );
}

/// Give up on an automatic bench swap: release only what this task owns, then
/// say why in the log.
pub(crate) async fn abort_auto_bench_swap(
    app: &tauri::AppHandle,
    tracker: &SharedTracker,
    champion_id: i32,
    token: u64,
    kind: &str,
    title: &str,
    reason: &str,
) {
    let mut tr = tracker.lock().await;
    tr.finish_bench_job(token);
    if tr.bot_expected_champ == Some(champion_id) {
        tr.bot_expected_champ = None;
    }
    emit_champ_select_state(app, &tr);
    drop(tr);
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": kind,
            "title": title,
            "reason": reason,
        }),
    );
}

/// Hand the bench back to new suggestions once an auto swap job has finished.
pub(crate) async fn release_auto_bench_job(app: &tauri::AppHandle, tracker: &SharedTracker, token: u64) {
    let mut tr = tracker.lock().await;
    if tr.finish_bench_job(token) {
        emit_champ_select_state(app, &tr);
    }
}

/// Opt-in automatic bench swap for one suggested champion.
///
/// Waits out the same local 3s bench lock the manual snipe honours, then sends
/// one swap at a time and retries at most 3 more times. Never sets
/// `manual_bench_hold`: an automatic swap is not a manual pick.
/// Whether the player may take this champion in the current champ select.
/// An unreadable list counts as pickable, so a failed lookup never blocks a swap.
async fn is_pickable(lcu: &SharedLcu, champion_id: i32) -> bool {
    pickable_allows(lcu.fetch_pickable_champion_ids().await.as_deref(), champion_id)
}

fn pickable_allows(pickable: Option<&[i32]>, champion_id: i32) -> bool {
    pickable.is_none_or(|ids| ids.contains(&champion_id))
}

pub(crate) async fn run_auto_bench_swap(
    app: tauri::AppHandle,
    lcu: SharedLcu,
    tracker: SharedTracker,
    champion_id: i32,
    token: u64,
    champ_name: String,
    retry_ms: u64,
) {
    // LCU answers 204 to a swap for a champion the player cannot pick and then
    // never applies it (Quinn, 2026-11-20): say why instead of resending.
    if !is_pickable(&lcu, champion_id).await {
        tracker.lock().await.bench_given_up.insert(champion_id);
        let reason = format!("【{}】不在本場可選清單（帳號沒有這隻英雄），本場不換它", champ_name);
        abort_auto_bench_swap(&app, &tracker, champion_id, token, "skip", "沒換到板凳英雄", &reason).await;
        return;
    }
    if let Err(e) = wait_for_bench_lock(&lcu, &tracker, champion_id, token).await {
        match e {
            // The new job owns the bench now; leave the tracker to it.
            BenchWaitError::Retargeted => {}
            BenchWaitError::LeftBench => {
                let reason = format!("【{}】還在 3 秒鎖內就被隊友換走，改找下一個順位", champ_name);
                abort_auto_bench_swap(&app, &tracker, champion_id, token, "skip", "沒換到板凳英雄", &reason)
                    .await
            }
            BenchWaitError::LeftChampSelect => {
                abort_auto_bench_swap(&app, &tracker, champion_id, token, "err", "自動換角已停止", "已離開選角")
                    .await
            }
        }
        return;
    }
    let unlocked_at = Instant::now();

    // LCU sometimes accepts a swap that never lands (2026-11-17/18 games): check
    // again after this long and resend while the champion is still on the bench.
    const UNLANDED_RECHECK: std::time::Duration = std::time::Duration::from_millis(500);
    const MAX_UNLANDED_RESENDS: u32 = 4;
    let mut unlanded_resends = 0u32;

    // One initial attempt plus at most 3 retries for failed requests.
    let mut attempt = 0u32;
    while attempt < 4 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(retry_ms)).await;
        }

        // A newer manual snipe or another auto swap may own the bench by now.
        {
            let mut tr = tracker.lock().await;
            if !tr.bench_job.owned_by(token) {
                return;
            }
            if tr.manual_bench_hold.is_some() || tr.my_champ_id == champion_id {
                // Nothing left to do: a manual pick landed, or we already hold it.
                tr.finish_bench_job(token);
                if tr.bot_expected_champ == Some(champion_id) {
                    tr.bot_expected_champ = None;
                }
                emit_champ_select_state(&app, &tr);
                return;
            }
            // Same lock hold as the ownership check: from here on this swap is
            // committed and a better suggestion may no longer take it over.
            // Mark the coming champion change as the bot's, not a manual pick.
            tr.commit_auto_bench(token);
            tr.bot_expected_champ = Some(champion_id);
        }
        if lcu.swap_bench(champion_id).await.is_ok() {
            let mut tr = tracker.lock().await;
            // `bot_expected_champ` stays set so the WS event for this swap reads
            // as a bot swap and takes no manual hold.
            // LCU accepting the request does not mean we got the champion (a
            // teammate may be faster): the next sessions settle and log it.
            let ignored = tr.record_bench_swap_sent(champion_id, unlocked_at, attempt);
            // The bench job stays ours until the swap is checked below, so a
            // new suggestion for the same champion does not start a second job.
            // A reply that arrives after the job ended (the WS event already
            // showed the swap) must not wipe the next suggestion.
            let still_ours = tr.bench_job.owned_by(token);
            // Emit under the same lock hold, so a newer suggestion cannot be
            // published in between and then cleared by this reply.
            if still_ours {
                tr.bench_suggest_target = None;
                tr.last_bench_verdict =
                    Some(format!("已送出換角請求 (ID: {})，等待確認", champion_id));
                emit_champ_select_state(&app, &tr);
                emit_lcu_assist(
                    &app,
                    serde_json::json!({ "kind": "clear", "target": "bench" }),
                );
            }
            drop(tr);
            if let Some(previous) = ignored {
                emit_bench_diag(
                    &app,
                    "上次請求沒生效",
                    format!(
                        "【{}】LCU 接受過 {} 次換角請求但都沒換到，已重送（距第一次解鎖 {} ms）",
                        champ_name,
                        previous.ignored_sends + 1,
                        previous.unlocked_at.elapsed().as_millis()
                    ),
                );
            }

            tokio::time::sleep(UNLANDED_RECHECK).await;
            let session = lcu.fetch_champ_select_session().await.ok();
            let check = match &session {
                Some(session) => engine::check_bench_swap(
                    champion_id,
                    session_my_champ_id(session),
                    &session_bench_champion_ids(session),
                ),
                // Left champ select: the session handler resets the tracker.
                None => engine::BenchSwapCheck::Lost,
            };
            if check == engine::BenchSwapCheck::NotLanded
                && let Some(session) = &session
            {
                // 2026-11-20: Quinn (not owned) never landed in 12 accepted
                // requests well past the opening window. Record whether LCU
                // lists the target as pickable, to test the ownership guess.
                let pickable = match lcu.fetch_pickable_champion_ids().await {
                    Some(ids) if ids.contains(&champion_id) => "是",
                    Some(_) => "否",
                    None => "讀不到",
                };
                emit_bench_diag(
                    &app,
                    "沒換到時的選角狀態",
                    format!(
                        "【{}】{}、可選清單有它：{}",
                        champ_name,
                        bench_swap_debug(session, champion_id),
                        pickable
                    ),
                );
            }
            if check != engine::BenchSwapCheck::NotLanded {
                // Landed or taken: the session handler logs the outcome.
                release_auto_bench_job(&app, &tracker, token).await;
                return;
            }
            if unlanded_resends >= MAX_UNLANDED_RESENDS {
                // Without this the next snapshot suggests it again and starts
                // a new job (2026-11-20: Quinn resent 7 more times after 已停止).
                tracker.lock().await.bench_given_up.insert(champion_id);
                abort_auto_bench_swap(
                    &app,
                    &tracker,
                    champion_id,
                    token,
                    "err",
                    "自動換角已停止",
                    &format!(
                        "【{}】LCU 接受了 {} 次換角請求都沒換到，本場不再自動換它",
                        champ_name,
                        unlanded_resends + 1
                    ),
                )
                .await;
                return;
            }
            unlanded_resends += 1;
            // It may have left and come back in between: honour a fresh 3s lock.
            if wait_for_bench_lock(&lcu, &tracker, champion_id, token).await.is_err() {
                release_auto_bench_job(&app, &tracker, token).await;
                return;
            }
            continue;
        }

        // The swap failed. A teammate may have taken it meanwhile: confirm the
        // bench before the next attempt instead of paying a GET before every
        // POST on the fast path.
        let Ok(session) = lcu.fetch_champ_select_session().await else {
            abort_auto_bench_swap(&app, &tracker, champion_id, token, "err", "自動換角已停止", "已離開選角")
                .await;
            return;
        };
        // A resend from a snapshot taken before our earlier swap landed: we
        // already hold the champion, so there is nothing to retry or report.
        if session_my_champ_id(&session) == champion_id {
            let mut tr = tracker.lock().await;
            tr.finish_bench_job(token);
            emit_champ_select_state(&app, &tr);
            return;
        }
        if !session_bench_champion_ids(&session).contains(&champion_id) {
            abort_auto_bench_swap(
                &app,
                &tracker,
                champion_id,
                token,
                "skip",
                "沒換到板凳英雄",
                &format!("【{}】被隊友先換走，改找下一個順位", champ_name),
            )
            .await;
            return;
        }

        // Clear the expectation so a later manual pick is still recognised.
        {
            let mut tr = tracker.lock().await;
            if tr.bot_expected_champ == Some(champion_id) {
                tr.bot_expected_champ = None;
            }
        }
        attempt += 1;
    }

    abort_auto_bench_swap(
        &app,
        &tracker,
        champion_id,
        token,
        "err",
        "自動換角已停止",
        &format!("英雄 (ID: {}) 自動換角重試 4 次仍失敗，已停止", champion_id),
    )
    .await;
}

/// Session fields that may explain a bench swap LCU accepted but never applied:
/// timer phase, bench flags, the target's bench entry and our own cell.
/// Names and account ids are dropped so the log stays free of personal data.
pub(crate) fn bench_swap_debug(session: &serde_json::Value, champion_id: i32) -> String {
    const PRIVATE_KEYS: [&str; 6] = [
        "gameName",
        "tagLine",
        "puuid",
        "summonerId",
        "obfuscatedPuuid",
        "obfuscatedSummonerId",
    ];
    let bench_entry = session
        .get("benchChampions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("championId").and_then(|v| v.as_i64()) == Some(champion_id as i64))
        })
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let local_cell_id = session.get("localPlayerCellId").and_then(|v| v.as_i64());
    let mut own_cell = session
        .get("myTeam")
        .and_then(|v| v.as_array())
        .and_then(|team| {
            team.iter()
                .find(|m| m.get("cellId").and_then(|v| v.as_i64()) == local_cell_id)
        })
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if let Some(obj) = own_cell.as_object_mut() {
        obj.retain(|k, _| !PRIVATE_KEYS.contains(&k.as_str()));
    }
    format!(
        "階段 {}、benchEnabled {}、板凳項目 {}、自己 {}",
        champ_select_phase(session),
        session.get("benchEnabled").unwrap_or(&serde_json::Value::Null),
        bench_entry,
        own_cell
    )
}

/// The champion our own cell currently holds in a champ select session.
pub(crate) fn session_my_champ_id(session: &serde_json::Value) -> i32 {
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

/// What a session says about a bench swap for `champion_id`: `Some(true)` we
/// hold it, `Some(false)` it left the bench to someone else, `None` not settled yet.
pub(crate) fn bench_swap_landed(session: &serde_json::Value, champion_id: i32) -> Option<bool> {
    if session_my_champ_id(session) == champion_id {
        Some(true)
    } else if !session_bench_champion_ids(session).contains(&champion_id) {
        Some(false)
    } else {
        None
    }
}

/// Finish a manual bench snipe: take the manual hold, release the bench if this
/// snipe still owns it, and record the result.
pub(crate) async fn finish_manual_bench_snipe(
    app: &tauri::AppHandle,
    tracker: &SharedTracker,
    champion_id: i32,
    token: u64,
    reason: String,
) {
    let mut tr = tracker.lock().await;
    // A newer job started since this snipe: it reports its own result.
    if !tr.is_latest_bench_job(token) {
        return;
    }
    tr.finish_bench_job(token);
    tr.manual_bench_hold = Some(champion_id);
    tr.bot_expected_champ = None;
    tr.last_bench_verdict = Some(reason.clone());
    emit_champ_select_state(app, &tr);
    drop(tr);
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({
            "kind": "act",
            "title": "已手動搶下板凳英雄",
            "reason": reason,
        }),
    );
}

/// Manual bench snipe from the overview card.
///
/// Waits out the 3s bench lock first (re-checking the session every 150ms), then
/// runs a bounded, strictly sequential retry loop (one HTTP request at a time,
/// `manual_snipe_interval_ms` apart, hard wall-clock and attempt caps). The
/// command itself always returns `Ok(())` so the UI never logs a spurious error
/// while the retry loop is doing its job.
#[tauri::command]
pub(crate) async fn swap_bench_champion(
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
    let token = {
        let mut tr = tracker.lock().await;
        let Some(token) = tr.start_manual_bench(champion_id) else {
            return Ok(());
        };
        tr.bot_expected_champ = Some(champion_id);
        token
    };

    // The UI shows `搶角中…` while a bench job holds the champion.
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
        if !is_pickable(&lcu_retry, champion_id).await {
            let mut tr = tracker_retry.lock().await;
            if tr.finish_bench_job(token) && tr.bot_expected_champ == Some(champion_id) {
                tr.bot_expected_champ = None;
            }
            emit_champ_select_state(&app_retry, &tr);
            drop(tr);
            let _ = app_retry.emit(
                "lcu-log",
                serde_json::json!({
                    "kind": "err",
                    "title": "手動搶角未成功",
                    "reason": format!("英雄 (ID: {}) 不在本場可選清單（帳號沒有這隻英雄），沒有送出", champion_id),
                }),
            );
            return;
        }
        // The 3s bench lock is enforced here: nothing is sent before it expires.
        // The wall-clock cap starts counting only after the wait, so a click at
        // second 0 still gets its full retry budget.
        if let Err(e) = wait_for_bench_lock(&lcu_retry, &tracker_retry, champion_id, token).await {
            let (kind, reason) = match e {
                // A newer snipe or the player's own pick took the bench over.
                BenchWaitError::Retargeted => return,
                BenchWaitError::LeftBench => (
                    "skip",
                    format!("英雄 (ID: {}) 還在 3 秒鎖內就被隊友換走", champion_id),
                ),
                BenchWaitError::LeftChampSelect => ("err", "已離開選角".to_string()),
            };
            let mut tr = tracker_retry.lock().await;
            if tr.finish_bench_job(token) && tr.bot_expected_champ == Some(champion_id) {
                tr.bot_expected_champ = None;
            }
            emit_champ_select_state(&app_retry, &tr);
            drop(tr);
            let _ = app_retry.emit(
                "lcu-log",
                serde_json::json!({
                    "kind": kind,
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
        let mut stop_reason = format!(
            "英雄 (ID: {}) 鎖定未解開或換角一直沒生效，已安全停止重試",
            champion_id
        );

        while started_at.elapsed() < max_elapsed && attempts < max_attempts {
            // 1. Cheap in-memory guards and marking the coming change as ours,
            //    in one lock hold so a newer snipe cannot slip in between.
            let already_ours = {
                let mut tr = tracker_retry.lock().await;
                if !tr.bench_job.owned_by(token) {
                    // The session already showed the champion landing (that ends
                    // the job, and no job has started since): record the success
                    // instead of ending silently. Otherwise a newer job owns the
                    // bench: leave it.
                    let landed = tr.is_latest_bench_job(token) && tr.my_champ_id == champion_id;
                    drop(tr);
                    if landed {
                        finish_manual_bench_snipe(
                            &app_retry,
                            &tracker_retry,
                            champion_id,
                            token,
                            format!("成功換取板凳英雄 (ID: {})，本局啟用手動保護", champion_id),
                        )
                        .await;
                    }
                    return;
                }
                // 2. The WebSocket event may have already granted us the champion.
                let ours = tr.my_champ_id == champion_id;
                if !ours {
                    tr.bot_expected_champ = Some(champion_id);
                }
                ours
            };
            if already_ours {
                finish_manual_bench_snipe(
                    &app_retry,
                    &tracker_retry,
                    champion_id,
                    token,
                    format!("成功換取板凳英雄 (ID: {})，本局啟用手動保護", champion_id),
                )
                .await;
                return;
            }

            // 3. Send immediately: the lock has expired, so do not spend a
            //    round trip on a pre-flight GET. LCU accepting the request does
            //    not mean we got the champion (a faster teammate may), so the
            //    session afterwards decides either way.
            let accepted = lcu_retry.swap_bench(champion_id).await.is_ok();

            let Ok(session) = lcu_retry.fetch_champ_select_session().await else {
                stop_reason = "已離開選角，已停止重試".to_string();
                break;
            };
            let landed = bench_swap_landed(&session, champion_id);
            if landed == Some(true) {
                finish_manual_bench_snipe(
                    &app_retry,
                    &tracker_retry,
                    champion_id,
                    token,
                    format!(
                        "成功換取板凳英雄 (ID: {})，解鎖後 {} ms 確認到手，本局啟用手動保護",
                        champion_id,
                        started_at.elapsed().as_millis()
                    ),
                )
                .await;
                return;
            }
            if landed == Some(false) {
                stop_reason = format!(
                    "英雄 (ID: {}) 被隊友先換走{}，已停止重試",
                    champion_id,
                    if accepted { "（LCU 收下了請求，但沒換到）" } else { "" }
                );
                break;
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
        // Only release what this loop owns: another job may own the bench now.
        if tr.finish_bench_job(token) && tr.bot_expected_champ == Some(champion_id) {
            tr.bot_expected_champ = None;
        }
        emit_champ_select_state(&app_retry, &tr);
        drop(tr);
        let _ = app_retry.emit(
            "lcu-log",
            serde_json::json!({
                "kind": "err",
                "title": "手動搶角已停止",
                "reason": stop_reason,
            }),
        );
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unpickable_bench_champion_is_not_swapped() {
        // Quinn (133) was not in the pickable list of the 2026-11-20 game.
        assert!(!pickable_allows(Some(&[37, 163]), 133));
        assert!(pickable_allows(Some(&[37, 133]), 133));
        // A failed lookup must not block a swap.
        assert!(pickable_allows(None, 133));
    }

    #[test]
    fn test_bench_swap_debug_keeps_bench_fields_and_drops_identity() {
        let session = serde_json::json!({
            "benchEnabled": true,
            "benchChampions": [{ "championId": 42, "isPriority": false }],
            "localPlayerCellId": 2,
            "myTeam": [{ "cellId": 2, "championId": 37, "gameName": "name", "puuid": "p", "summonerId": 1 }],
            "timer": { "phase": "BAN_PICK" }
        });
        let text = super::bench_swap_debug(&session, 42);
        assert!(text.contains("\"isPriority\":false"));
        assert!(text.contains("\"championId\":37"));
        assert!(text.contains("benchEnabled true"));
        assert!(!text.contains("name") && !text.contains("\"p\"") && !text.contains("summonerId"));
    }

    use serde_json::json;

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
    fn test_bench_swap_landed_reads_the_session_not_the_http_reply() {
        let session = |mine: i32, bench: &[i32]| {
            json!({
                "localPlayerCellId": 3,
                "myTeam": [{ "cellId": 3, "championId": mine }],
                "benchChampions": bench.iter().map(|c| json!({ "championId": c })).collect::<Vec<_>>()
            })
        };
        // We hold Corki (42).
        assert_eq!(bench_swap_landed(&session(42, &[800]), 42), Some(true));
        // A teammate took Corki: it left the bench, we still hold Mel (800).
        assert_eq!(bench_swap_landed(&session(800, &[112]), 42), Some(false));
        // Not settled yet: Corki still on the bench.
        assert_eq!(bench_swap_landed(&session(800, &[42, 112]), 42), None);
    }

    #[test]
    fn test_bench_lock_remaining_secs_honours_the_local_three_second_lock() {
        // A champion that just landed on the bench stays locked.
        assert!(bench_lock_remaining_secs(Some(2.9), "BAN_PICK", None) > 0.0);
        // The full lock is served.
        assert_eq!(bench_lock_remaining_secs(Some(3.0), "BAN_PICK", None), 0.0);
        // Never seen: be conservative and wait the whole lock.
        assert_eq!(bench_lock_remaining_secs(None, "BAN_PICK", None), 3.0);
        // Opening of BAN_PICK: LCU ignores swaps before ~15 s (2026-11-18 games).
        assert_eq!(bench_lock_remaining_secs(Some(5.0), "BAN_PICK", Some(9.0)), 6.0);
        assert_eq!(bench_lock_remaining_secs(Some(5.0), "BAN_PICK", Some(16.0)), 0.0);
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
    fn test_phase_left_secs_reads_the_session_timer() {
        let session = json!({
            "timer": {
                "phase": "BAN_PICK",
                "totalTimeInPhase": 15000,
                "adjustedTimeLeftInPhase": 6000,
                "internalNowInEpochMs": now_epoch_ms()
            }
        });
        let left = phase_left_secs(&session).unwrap();
        assert!((5.9..=6.0).contains(&left), "got {}", left);
        assert_eq!(phase_left_secs(&json!({})), None);
    }

    #[test]
    fn test_bench_lock_skips_the_last_poll_only_when_it_cannot_send_early() {
        // FINALIZATION with less than one poll left: sleep it out, no extra poll.
        let finish =
            |phase, remaining| can_finish_bench_lock_without_poll(phase, remaining, 0.15, None);
        assert!(finish("FINALIZATION", 0.1));
        assert!(finish("FINALIZATION", 0.15));
        // More than one poll left: keep polling so a teammate's pick is noticed.
        assert!(!finish("FINALIZATION", 0.2));
        // BAN_PICK can still turn into FINALIZATION, whose phase clock adds a
        // fresh 3s lower bound, so the next poll must recompute the lock...
        assert!(!finish("BAN_PICK", 0.1));
        assert!(!finish("", 0.1));
        // ...unless the phase clock shows BAN_PICK outlasting the unlock.
        let ban_pick = |left| can_finish_bench_lock_without_poll("BAN_PICK", 0.1, 0.15, left);
        assert!(ban_pick(Some(5.0)));
        assert!(!ban_pick(Some(0.5)));
        assert!(!ban_pick(None));
        // Sleeping the computed remainder always reaches the full 3s lock.
        let seen = 2.9;
        let remaining = bench_lock_remaining_secs(Some(seen), "FINALIZATION", Some(10.0));
        assert!(seen + remaining >= 3.0);
    }
}
