use std::sync::Arc;
use std::time::Duration;
use tauri_app_lib::lcu::LcuManager;

#[tokio::test]
async fn test_live_lcu_connection() {
    let detected = LcuManager::detect_auth();
    println!("Detected LCU Auth: {:?}", detected);

    if detected.is_none() {
        println!("Note: LoL Client is not running right now. Skipping live client check.");
        return;
    }

    let auth = detected.unwrap();
    println!(
        "Connected to Port: {}, Token length: {}",
        auth.port,
        auth.token.len()
    );

    let manager = Arc::new(LcuManager::new());
    Arc::clone(&manager).start_watcher();

    // Wait 2.5s for watcher to pick up auth and start websocket
    tokio::time::sleep(Duration::from_millis(2500)).await;

    assert!(manager.is_connected().await, "Manager should be connected");

    // Fetch champions
    match manager.fetch_champions().await {
        Ok(champs) => {
            println!("Successfully fetched {} champions from LCU!", champs.len());
            assert!(!champs.is_empty());
            // Only standard playable champions: no Classic Mode (Jade_*) or dummy entries.
            assert!(
                champs.iter().all(|c| c.id > 0 && c.id < 10000),
                "champion list must not contain classic-mode or dummy ids"
            );
            assert!(
                champs.len() < 200,
                "expected ~172 standard champions, got {}",
                champs.len()
            );
            if let Some(first) = champs.first() {
                println!("First champion: ID {} -> {}", first.id, first.name);
            }
        }
        Err(e) => panic!("Failed to fetch champions: {}", e),
    }

    // Fetch champion mastery if available
    match manager.fetch_champion_mastery().await {
        Ok(mastery) => {
            println!("Fetched {} mastery entries from LCU!", mastery.len());
            if let Some(top) = mastery.first() {
                println!(
                    "Top mastery champ ID {} with {} points (level {})",
                    top.champion_id, top.champion_points, top.champion_level
                );
            }
        }
        Err(e) => println!("Note: could not fetch mastery (maybe not in lobby): {}", e),
    }

    println!("All live LCU tests passed successfully!");
}
