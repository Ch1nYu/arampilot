# lolafk 專案 — Agent 指引

動工前先讀 `HANDOVER.md`，它是本專案唯一的進度與脈絡來源（架構、里程碑、資料流、排序工作台流程、目前狀態、下一步）。收工前把你的進展更新回去。

## 硬性邊界

- 禁止任何遊戲內輸入模擬（虛擬按鍵或滑鼠）；自動化一律走本地 LCU API 與 `https://127.0.0.1:2999`。這是 Vanguard 紅線。
- `%APPDATA%/lol-aram-assistant/config.json` 是使用者的真實設定。任何寫入 profile 的路徑都必須保留每個英雄的 `elo` / `matches` 欄位，否則會清掉大比拚的累積權重。
- lab 工作資料（`sorting-autosave.json`、`aram-assistant-sorted-*.json`、`aram-assistant-backup.json`）不提交進 git；它們在 `.gitignore` 內，只留在磁碟上。

## 驗證（宣稱完成前必跑）

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tsc --noEmit && pnpm build
```

動到前端或 Rust 共用模組時兩組都跑；只動 `mockups/` 時至少做一次受影響頁面的 smoke test。

## 慣例

- Commit 用 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:`），一個里程碑一個 commit。
- 前端與 Rust 的設定欄位變更要同步更新 `HANDOVER.md` 的資料流段落。
