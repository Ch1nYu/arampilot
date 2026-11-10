# ARAMPilot — Agent 指引

架構與功能見 `README.md`。私人開發 repo 另有 `HANDOVER.md`（進度與脈絡紀錄，不進公開 repo）：有的話動工前先讀，收工前更新回去。

## 硬性邊界

- 禁止任何遊戲內輸入模擬（虛擬按鍵或滑鼠）；自動化一律走本地 LCU API 與 `https://127.0.0.1:2999`。這是 Vanguard 紅線。
- `%APPDATA%/ARAMPilot/config.json` 是使用者的真實設定（舊名 `lol-aram-assistant`，啟動時自動改名）。任何寫入 profile 的路徑都必須保留每個英雄的 `elo` / `matches` 欄位，否則會清掉大比拚的累積權重。
- lab 工作資料（`sorting-autosave.json`、`aram-assistant-sorted-*.json`、`aram-assistant-backup.json`）不提交進 git；它們在 `.gitignore` 內，只留在磁碟上。

## 驗證（宣稱完成前必跑）

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tsc --noEmit && pnpm build
pnpm test        # vitest：前端純邏輯
```

動到前端或 Rust 共用模組時兩組都跑；只動 `mockups/` 時至少做一次受影響頁面的 smoke test。

### GUI 實測（CDP）收尾

- 為驗證啟動的程序（App 實例、headless 瀏覽器、`pnpm dev`）都記下 PID；回報前逐一結束，再用 `Get-Process -Id <PID>` 確認已不在。使用者自己開的 App 一律不碰。
- 隔離實例：設 `APPDATA` 與 `WEBVIEW2_USER_DATA_FOLDER` 到暫存資料夾，`--remote-debugging-port` 用沒被佔的 port（先查 `/json`）。改 `LOCALAPPDATA` 會讓 WebView2 建立失敗（`0x8007139F`）。
- 使用者的 App 常跑在 `src-tauri\target\debug\tauri-app.exe`，建置測試版時用另一個 `CARGO_TARGET_DIR`，避免覆寫正在執行的 exe。
- 使用者開著 `pnpm tauri dev` 時，存檔改到 Rust 就會自動重編、用真實 `%APPDATA%` 資料重啟 App。改到設定格式或資料遷移之前，先請使用者關掉 dev App。

## 慣例

- Commit 用 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:`），一個里程碑一個 commit。
- 前端與 Rust 的設定欄位要一起改；有 `HANDOVER.md` 時同步更新它的資料流段落。
