# LoL ARAM 輕量助手 — 接續開發記錄 (Handover / Source of Truth)

> 本文件是專案唯一的進度與脈絡來源。任何 agent 動工前先讀完；收工前把自己的進展更新回「§6 目前狀態」與「下一步」。
> 最後更新：2026-11-08（補登，涵蓋昨夜收尾與今日事項）。

---

## 0. 現況 TL;DR

- **主程式可用且乾淨**：Tauri v2 桌面程式，含開局自動接受、英雄卡自動選擇、板凳搶角、隊友換角判定、系統匣、8:00 投降提醒、二選一大比拚（ELO PK）、設定持久化。最近驗證（2026-11-07 本機實測）：`cargo test` 41 + 1 全過、`pnpm tsc --noEmit` 無錯、`pnpm build` 成功。
- **最新一輪工作（`0b821c8`，2026-11-07）**：`mockups/algo-lab.html` 從「v2 遞移 PK 實驗室」改版為「初排快篩 + Binary Divide 二分定位 + 拖拉微調」排序工作台；autosave server 收進 repo（`mockups/autosave_server.py`），lab 每次操作都會寫入 App 的 `%APPDATA%` 設定。
- **進行中**：無未修完的程式缺陷。排序工作台可日常使用。
- **11/7 傍晚追加**：使用者已定稿 11/7 排序；App 已由 dev 鏈自動 rebuild 後重啟（PID 32956，18:24 啟動），載入最新排序；`mockups/algo-lab.html` 內嵌種子已同步為 11/7 定稿排序（`e8fe99d`）；搶板凳的 skip/重試失敗原因現在會在「執行紀錄」顯示（`cb00827`）。
- **11/7 晚追加**：`ad179e9` beep 改吃持久 AudioContext（ff 延遲主因是每次新建 context，約數百 ms 且上限/暫停問題）、trade 好友分類寫 log＋allies 抓取重試（A 方案）；`62d50c8` 複製預設關（live 設定已改 false，App 下次重啟後記憶體亦為 false）；vite dev server 曾死掉（GUI 空白），已重啟並觸發 App 重啟（PID 42928，21:51 啟動），GUI 恢復。
- **11/8 補登**：App 目前 PID 12408（23:35 重啟後存活）、vite 200、GUI 正常；ff 複製已實作關閉（開關仍在、預設 false，App 記憶體亦為 false）；trade 好友辨識 log 與重抓已在新 App 跑。明日見 §6.3。
- **需要使用者做一次的事**：若 lab 分頁是改版前開的，重新載入（F5）一次。舊分頁的 JS 會把 `elo/matches` 從 profile 剝掉；重新載入後就帶著走（細節見 §4.3）。這批權重已在 2026-11-07 由修復腳本補回，目前 `%APPDATA%` 設定 173/173 都帶 `elo`。
- 本 repo 沒有 git remote；commit 只留本機（使用者的權限設定也把 `git push` 設為 deny）。

---

## 1. 專案目標與邊界

- **目標**：《英雄聯盟》**ARAM（queue 450）** 與 **ARAM: Mayhem（queue 2400；含 2410 賽事、3270 自訂）** 的個人偏好自動化工具。
- **邊界原則**：
  - 100% 使用本地官方 LCU API 與 Live Client Data (`https://127.0.0.1:2999`)。
  - **嚴禁**遊戲內任何虛擬按鍵/滑鼠模擬（不踩 Vanguard 反作弊紅線）。
  - 不做版本強度/出裝推薦；專注個人喜好排序與選角、換角、板凳自動化。

---

## 2. 技術棧與檔案地圖

- **桌面框架**：Tauri v2（`@tauri-apps/api@2`、`tauri@2`）。
- **前端**：Vite 8 + Vanilla TypeScript + 原生 CSS。
  - 主題：極簡深色，強調色緋紅 `#EF4444`。
  - 分級：`本命 (90-100)`、`愛角 (75-89)`、`順手 (60-74)`、`勉強 (40-59)`、`封印 (10-39)`、未分類（基準分 40，於規則引擎視為 40 分）。

| 路徑 | 內容 |
|---|---|
| `index.html` | 主程式 DOM：首頁、英雄優先序、二選一大比拚、設定（含開發用測試按鈕） |
| `src/main.ts` | 全部前端互動：LCU 狀態介面、優先序拖曳、閃卡分類、二選一 PK（ELO）、設定同步 |
| `src/styles.css` | UI 樣式與主題 |
| `src/champions.ts` | 內建 173 隻標準繁中英雄清單（未開 LoL 也有完整清單） |
| `src-tauri/src/lcu.rs` | LCU 連線（sysinfo 解析 `LeagueClientUx.exe` port/token、自簽 HTTPS+WS、lockfile 檢查）、英雄清單、帳號專精、subset champion list、champion-swaps 換角、朋友/組排識別、自訂房測試端點 |
| `src-tauri/src/engine.rs` | 選角規則引擎：卡片選擇、板凳搶角（`UNRANKED_BASELINE_SCORE = 40`）、換角判定（含組排好友政策）＋單元測試 |
| `src-tauri/src/config.rs` | AppConfig 持久化（`%APPDATA%/lol-aram-assistant/config.json`）、`sanitize()`、Windows 開機自啟（登錄檔） |
| `src-tauri/src/livegame.rs` | 遊戲內 8:00 投降提醒輪詢（唯讀 2999 + 剪貼簿 + 音效） |
| `src-tauri/src/lib.rs` | Tauri commands、事件轉發、系統匣、ReadyCheck 自動接受、選角事件處理、板凳狙擊重試排程 |
| `src-tauri/capabilities/default.json` | Tauri 視窗與核心權限（含標題列拖曳權限） |
| `mockups/algo-lab.html` | 排序工作台（Binary Divide + 拖拉看板 + 初排快篩），見 §5 |
| `mockups/autosave_server.py` | 排序工作台硬碟自動存檔 server（預設 `127.0.0.1:18998`），見 §4.2 |
| `mockups/style-options.html` | 最早期的 UI 風格 mockup（歷史文件，未使用） |
| `HANDOVER.md`（本檔） / `AGENTS.md` | 進度來源 / agent 動工指引 |

驗證與啟動指令見 §7。

---

## 3. 里程碑年表（新到舊，一切以 `git log` 為準）

### 2026-11-08（第 13 輪：WebView2 CDP 實測 GUI 驗證）

- **以 WebView2 CDP 直接操作 GUI 驗證（不用 OS 座標點擊，不接管實體滑鼠）**：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 重啟 `tauri-app.exe`，用零依賴 Node 腳本（`%TEMP%\opencode\ui\cdp.mjs`、`evalfile.mjs`）做截圖、DOM 點擊、`Runtime.evaluate` 讀值。
  - 合併結果：`aram_profile` / `mayhem_profile` 皆 173 筆且逐欄相同、`aram_settings` / `mayhem_settings` 相同；`primary_spell_key="D"`、`bench_diff_threshold=5`、`ff_time_aram="08:00"`，舊欄位仍在。
  - 切主／副鍵位 D ⇄ F：`get_app_config` 與 `config.json`（`LastWriteTime` 同步前進）一致，還原 D 後亦同。
  - 預設副技能改虛弱 (3) → 檔案立即變 3，還原鬼步 (6)；`cfgAutoSpells` 關 → `auto_summoner_spells=false`，開 → `true`。
  - 英雄優先序拖曳：以 DOM `dragstart → dragover → drop` 把伊澤瑞爾拖到好運姐之後，DOM 與 `aram_profile` 同步換序（分數依序重算），再拖回原位後與驗證前的備份 `config-before.json` 逐鍵 diff「零差異」，`elo` / `matches` 全程保留。
  - 三欄總覽、優先序分層（本命 90–100…）與一般設定技能卡（第一章、選角以外不 PATCH）畫面確認；Console 只有 favicon 404。
- `0f7976d` **「⋯ 其他」托盤標籤換行修復**：`.spell-btn` 補 `white-space: nowrap`、托盤內按鈕 `flex: none`，清晰／虛弱／點燃不再被擠成直排。

### 2026-11-08（第 12 輪：徹底合併一般 ARAM 與海克斯 Mayhem 設定與排名）

- **合併 ARAM 與 Mayhem 為單一共用設定與優先序（使用者拍板）**：
  - 移除視窗標題列的 `#globalModeSeg`（`海克斯 Mayhem ｜ 一般 ARAM`）切換鈕與「英雄優先序」頁的「⇄ 複製至 ARAM」按鈕。
  - 前端 `src/main.ts` 刪除所有雙份 mode map（`PROFILES`、`modeSettings`、`ffTimes`、`ELOByProfile`、`pkComparisonsByProfile` 等），統一改為單一共用狀態（`profileList`、`currentSettings`、`ffTime`、`eloMap`、`pkComparisonsMap`）。
  - 後端 `src-tauri/src/config.rs` 在 `AppConfig::sanitize()` 中自動挑選分類資訊最完整的清單（保留使用者最新將「剎雅」拉入本命與「好運姐」帶鬼步的狀態，並雙向補齊 `elo` / `matches` / `secondary_spell` / `flag`），同步寫入 `aram_profile` 與 `mayhem_profile` 以相容既有設定檔與外部工具；`src-tauri/src/lib.rs` 刪去 50 行雙模式合併分支，直接讀取單一設定。

### 2026-11-08（第 11 輪：修復 GUI 切換召喚師技能被 350ms 延遲覆蓋回去＋總覽簡化與設定移至一般設定）

- **自動接受對戰（ReadyCheck）延遲排查與消除多餘查詢**：
  - 使用者於 `08:56:08` 觀察到約 2 秒延遲，原因有二：(1) 設定檔的「自動接受對戰 → 延遲秒數 (`accept_delay_sec`)」目前設為 `1.5 秒`（紀錄第 293 行 `08:56:08` 偵測 → `08:56:10` 接受）；(2) `handle_ready_check_event` 在睡眠前後重複查詢了兩次 `fetch_current_queue_id`（外加 `fetch_gameflow_phase`），多花約 0.2～0.4 秒。
  - 已刪除睡眠後的重複 `fetch_current_queue_id` 查詢，並將睡眠前查詢 `queue_id` 耗費的毫秒數從 `safe_delay` 扣除；若使用者想要秒按接受，將「對戰與選角 → 自動接受對戰 → 延遲秒數」拉到 `0 秒` 即可瞬間接受。
- **修復從 GUI 點擊切換召喚師技能時 LoL 畫面沒變成鬼步的根因（`08:23:03` 競態缺陷）**：
  - `exec-log.jsonl` 第 259-260 行顯示：`08:23:03` 使用者點鬼步時，`apply_summoner_spells` 確實在 LCU 把好運姐改成了鬼步；但前端原本用 `debouncedSaveConfig()`（延遲 350ms 才存進 Rust `SharedConfig`），導致 LCU 在 ~10ms 後回傳 WebSocket 事件時，Rust `handle_champ_select_event` 讀到舊設定（雪球）並在同 1 秒內立刻發送 PATCH 把鬼步覆蓋回雪球！
  - 修正：點擊技能或切換主副鍵位時改走 `await saveConfigImmediate()` 先同步寫入後端，再呼叫 `apply_summoner_spells`；同時 `apply_summoner_spells` 鎖定 `tr.manual_spell_override = true` 且 Mayhem 繼承 ARAM 時同步保留 `secondary_spell`，徹底消除被 WebSocket 事件覆蓋回去的問題。
- **總覽介面簡化 ＋ 主／副鍵位設定移至「⚙ 一般設定」最上方**：
  - 將「自動帶召喚師技能（D / F 主副鍵位切換 ＋ 預設副技能 ＋ 清除英雄記憶）」從原本「對戰與選角」最底部（需捲動才看得到）移到 **「⚙ 一般設定」第一張卡片**，點開一般設定第一眼即可切換 `[D 閃現（主）／ F 副技能]` ⇄ `[F 閃現（主）／ D 副技能]`。
  - 總覽頁「我的英雄」卡片拿掉多餘文字標籤，平時待機完全不顯示技能按鈕；僅在進入選角拿到英雄時，於英雄下方顯示單行精簡小圖示（`F 副技能 [鬼步] [雪球] [⋯]`）。

### 2026-11-08（第 10 輪：召喚師技能自動攜帶、練習工具／召喚峽谷模式阻擋與手動改技能保護、GUI 拖移修復）

- **修復練習工具／召喚峽谷誤觸發自動化與覆蓋手動召喚師技能（使用者實測回報）**：
  - **問題 1（模式檢測漏洞）**：舊版 `fetch_current_queue_id` 過濾掉 `queueId <= 0` 後回傳 `None`，而 `handle_champ_select_event` 與 `start_ff_poller` 只判斷 `is_mayhem_queue`，把所有非 Mayhem 模式（包含練習工具 `PRACTICETOOL`、召喚峽谷 `mapId: 11` / `CLASSIC`、一般/積分等）全部當成 ARAM 執行自動帶技能與 8:00 投降提醒。
  - **修正 1**：`lcu.rs` 新增 `resolve_queue_id_from_session_or_lobby` 同時檢查 `queueId`、`gameMode` 與 `mapId`（練習工具與召喚峽谷明確回傳 `-1` 或原峽谷 queue ID；自訂咆哮深淵 `KIWI`/`ARAM` 才對應 `3270`/`3200`）；`handle_champ_select_event` 與 `start_ff_poller` 嚴格檢查 `is_mayhem_queue || is_aram_queue`，非大亂鬥模式一律完全停用選角、換技能與投降提醒；`handle_ready_check_event` 亦提前阻擋非生效模式。
  - **問題 2（手動改技能被覆蓋）**：玩家在客戶端手動改過召喚師技能後，選角事件仍會被自動套用覆蓋。
  - **修正 2**：`ChampSelectSessionTracker` 新增 `observe_client_spells`（追蹤 `initial_client_spells`、`bot_set_spells` 與 `manual_spell_override`），一旦偵測到玩家在 LoL 客戶端手動變更 D/F 技能，本局立即鎖定 `manual_spell_override = true` 並寫入紀錄，後續就算換角也不再自動覆蓋。
- **自動帶召喚師技能（D / F 主副槽位 + 英雄專屬記憶 + 鬼步/雪球與展開選單）**：
  - 第一層（鍵位習慣）：`AppConfig` 新增 `auto_summoner_spells`（預設 `true`）與 `primary_spell_key`（`"D"` 或 `"F"`，預設 `"D"` 把閃現放 D 鍵、副技能放 F 鍵，可一鍵切換）。
  - 第二層（B+A 英雄個別記憶＋預設與快速切換）：`ModeSettings` 新增 `default_secondary_spell`（預設 `6` 鬼步），`ChampionProfileItem` 新增 `secondary_spell: Option<i32>`。介面在「對戰與選角」頁與「總覽 → 我的英雄」卡皆常駐顯示 **鬼步 (6)**、**雪球 (32)** 圖示，並提供 **「⋯ 其他」圖示按鈕** 點開選擇 **清晰 (13)、虛弱 (3)、點燃 (14)、光盾 (21)、治癒 (7)、淨化 (1)**。
  - 選角時若該英雄有記憶專屬副技能即自動套用，否則套用模式預設，透過 `PATCH /lol-champ-select/v1/session/my-selection` 自動帶上；在總覽「我的英雄」卡點選副技能會立即切換並自動記住該英雄的副技能。
- **修復桌面 GUI 無法手動拖移英雄優先序與閃卡**：
  - 根因：Tauri v2 在 Windows WebView2 預設 `dragDropEnabled: true` 會註冊視窗級別的 OLE 檔案拖放攔截，直接吃掉 DOM 內部的 HTML5 `dragover` / `drop` 事件。
  - 修正：`src-tauri/tauri.conf.json` 明確設為 `"dragDropEnabled": false`，並在 `src/main.ts` 補齊 `dataTransfer.setData("text/plain", ...)` 與同卡拖放防誤移保護。

### 2026-11-08（第 9 輪：總覽三欄改版與手動搶角防濫用連點保護）

- **總覽頁三欄改版（照 `mockups/overview-redesign.html` 定稿實作）**：
  - 左欄「我的英雄」：顯示 52×52 頭像、名稱、分級與分數，若玩家手動換角或標記 `🔒 不換出` 則顯示保護徽章，底部直接顯示後端判定（`ChampSelectUiState`）。
  - 中欄「板凳（全部，依分數高→低排）」：列出板凳上所有英雄，最高分達標者高亮紅框、顯示即時分差與「搶角」按鈕（重試中顯示 `搶角中…` 並鎖定按鈕；`封印` 與 `⛔ 不搶` 顯示「不搶」），底部顯示後端判定原因。
  - 右欄「隊友換角請求」：自動比對 `allied_puuids` / `allied_summoner_ids` 標示 `組排/好友` 或 `一般路人` 標籤、隊友名稱、交換對象與分差，並提供「同意／拒絕」按鈕與後端判定說明。
- **手動「搶角」安全連點（防無窮迴圈／防濫用保護）**：
  - 單一排程鎖（`manual_snipe_generation` + `bench_retry_target`）：同一目標重複點擊不疊加迴圈；改點其他英雄立即取消舊迴圈。
  - 嚴格等待回報（Sequential Await）：每次必須等上一次 HTTP 回應完成後才計時 120ms，絕不併發轟炸 LCU。
  - 雙重硬上限與狀態短路：最長 3.2 秒或最多 24 次嘗試即強制停止；每 3 次查詢 session 確認是否已拿到該英雄、該英雄是否已被隊友選走、或尚在階段鎖定（鎖定期間只 sleep 不發 POST）；手動搶下後自動設定 `manual_bench_hold` 保護不被自動搶板凳換走。

### 2026-11-08（第 8 輪：ARAM/Mayhem 介面簡化、10+2 輪選角實測與 ReadyCheck 修復）

- **ARAM / Mayhem 介面簡化（合併介面、資料分流）**：將散落在「對戰與選角」、「換角規則」、「英雄優先序」、「二選一大比拚」與「投降提醒（雙時間欄位）」的重複模式切換整合為視窗頂部單一模式按鈕（`#globalModeSeg`，預設 `海克斯 Mayhem`），切換時全頁同步，底層 `aram_profile` / `mayhem_profile` 與設定仍各自獨立保存。
- **執行紀錄落盤可觀測（`append_exec_log`）**：前端 `addLog` 同步追加寫入 `%APPDATA%/lol-aram-assistant/exec-log.jsonl`，方便實測與事後對照。
- **10 輪自訂選角 + 2 輪板凳強制高分卡實測**：
  - 10 輪一般自訂房測試：每輪皆在 1.5s 準時自動挑走開局卡池最高分英雄（拉克絲 86、威寇茲 72、納瑟斯 66、凱能 80、枷蘿 72、雷茲 91、拉克絲 86、希格斯 93、魔鬥凱薩 79、索拉卡 76），並因單人房板凳只剩自己未選的低分卡（或希格斯 `🔒 不換出`）而正確記錄「略過搶板凳」。
  - 2 輪開局刻意拿低分卡讓高分卡落入板凳：板凳 3 秒鎖定解鎖瞬間皆成功觸發 `已從板凳秒換偏好英雄`（維迦 +40 分、庫奇 +27 分），證實板凳狙擊端點與 80ms 重試鏈在自訂 Mayhem 完全正常；前次使用者自訂測試未換角確係手動點選觸發 `manual_bench_hold`（尊重手動選角保護）或單人房已拿最高分卡所致。
- **修復 ReadyCheck 計時與自訂房 500 報錯**：LCU `/lol-matchmaking/v1/ready-check` 的 `timer` 為「已過秒數（0→12s 上數）」，舊版誤當剩餘秒數導致 `timer=0.0` 時延遲被歸零，且在單人自訂房瞬跳 `ChampSelect` 時重複送出過期 `accept` 產生 `HTTP 500`；已改為 `10.5 - elapsed` 計算並在發送前檢查仍在 `ReadyCheck`。同時在 `select_champion_card` 前標記 `bot_expected_champ`，避免開局自動選卡被誤判為手動換角。

### 2026-11-07（第 7 輪：總覽 tile 移除、草圖定稿討論）

- `210b933` **總覽 tiles 移除**：自動化開關在總覽與設定頁重複（使用者指出），總覽只留狀態卡＋追蹤點；`main.ts` 的 TILES/同步函式與 `index.html #tiles` 已刪，共享設定（cfgAutoAccept 等）不動。
- `mockups/overview-redesign.html` 草圖定稿討論：板凳全列（捲動）、換角卡（名字＋路人/好友 chip＋同意/拒絕）、三卡 + log；示範資料已換成 11/7 真實排序（凱莎 99 > 好運姐 98 > 庫奇 94 > 雷茲 91，未達門檻 8 分手動可換）。待使用者拍板後再改 App 的首頁。

### 2026-11-07（第 6 輪：ff beep 修復、trade 可觀測、複製預設關）

- `ad179e9` **持久 beep context＋trade 分類 log**：`playBeepAlert()` 原本每次都新建 AudioContext（約數百 ms 延遲、暫停/上限問題），改共用一個 + resume；換角請求識別寫 `lcu-log`（含 cell id、分類、policy），allies 抓取為空時重試至多 3 次（避免第一次 transient 失敗把整場分類打成路人）。
- `62d50c8` **ff 複製預設關**：Riot 客戶端在 25.24 前後擋掉遊戲外來源的貼上（剪貼簿複製仍正常，但貼不進遊戲聊天），保留音效＋桌面通知。live 設定已改 false，App 下次重啟後記憶體亦為 false；lab 匯出模板同步關。
- **ff 提醒延遲診斷**：poller 在 `2dce87c` 後已是 adaptive cadence（2s 平時、窗口 0.15–0.5s），偵測誤差 ≤~0.7s；主要延遲是前端 `playBeepAlert()` 每次新建 AudioContext（已修）。桌面通知另有 Windows toast 顯示延遲（全螢幕遊戲時看不到），音效為主訊號。
- **App 程序狀態（11/7 晚）**：App 已由 dev 鏈 rebuild 後自動重啟（新 PID 12408，23:35 啟動；舊 PID 42928 已退出），記憶體設定 = 11/7 定稿排序 + `ff_copy_clipboard=false`。
- **GUI 修復**：`vite` dev server 曾死亡（1420 無人聽，App 視窗壞掉），已重啟 vite 並觸發 App 重啟，窗口恢復載入。死法：devServer 子程序 died 但 tauri CLI 與 app 還活著，devUrl 404 空殼。預防：重啟 App 前先確認 1420 活著。

### 2026-11-07（第 5 輪：排序收尾、搶板凳可觀測性）

- `cb00827` **搶板凳「為何沒換」可觀測性**：`evaluate_bench` 的 Skip 原因（手動 hold / 剩餘時間 / ⛔ 標記 / 未達門檻 / 開關）去重寫入 `lcu-log`，執行紀錄會顯示「略過搶板凳」；重試鏈耗盡改寫「搶板凳未成功」。背景：使用者在自訂 Mayhem 測試中看到手上是愛角藍寶、板凳有本命雷茲 94 分高 18 分卻沒自動搶角，而舊版本對 skip 完全無紀錄、事後無法回顧原因。
- `e8fe99d` **排序快照**：lab 種子換成 173 隻定稿排序（含 `elo`/`matches`，本命 18 / 愛角 40 / 順手 62 / 勉強 43 / 封印 10），與 `%APPDATA%` 設定一致（快照前已驗證 aram==mayhem）。
- **GUI 套用**：App 已由 dev 鏈重啟（新 PID 32956），記憶體設定換成 11/7 定稿排序。注意：舊的執行紀錄是記憶體裡的，隨重啟消失。

### 2026-11-07（第 4 輪：排序工作台改版）
- `0b821c8` **排序工作台改版＋autosave server 入庫**：`mockups/algo-lab.html` 重寫為 Binary Divide 工作台；`mockups/autosave_server.py` 從臨時腳本收進 repo（新增 `--port/--root/--no-appdata` 與 elo/matches 補回機制）；修同層拖曳 off-by-one、禁止拖到自己身上觸發誤移；lab 寫 profile 時保留 `elo/matches`；lab 工作資料與 `__pycache__` 加入 `.gitignore`。
- 同批收尾：本文件與 `AGENTS.md`、`README.md` 更新為現行版本；`elo/matches` 權重經修復 POST 補回 live 設定（見 §4.3）。

### 2026-11-06（第 3 輪：整合、審計、板凳狙擊）
- `2dce87c` 8:00 投降提醒改為 sub-second 精準觸發；換角只處理 `RECEIVED` 狀態（`AVAILABLE` 不再誤判），同格位後續請求可重新處理；同 commit 首次加入 `mockups/algo-lab.html`（v2 版）。
- `0251c19` 側欄新增自訂房測試按鈕（▶ 測選角 / ⏹ 退房，不進遊戲）；大比拚的 `elo`/`matches` 寫入 profile 持久化並支援復原（Backspace）；`lcu.rs` 新增自訂房端點。
- `e97aa25` 板凳狙擊時序對齊 Riot 揭示/定案鎖定規則，成功路線改 80ms 連續 burst。
- `5d29922` 換角改用 champion-swaps 端點；板凳重試精確排程。
- `987b6ef` 尊重玩家手動選角（不覆蓋）；板凳狙擊重試加速到 250ms 節奏。
- `fb5c569` 首頁 phase 指示燈即時同步；讀取 lobby queueId；ARAM/Mayhem 兩份 profile 互相複製與切換。
- `97ecea6` 支援自訂 ARAM/Mayhem queue ID；修 broadcast channel 拖累退出；強制刷新工作列圖示。
- `c172fa9` 6 項審計缺陷：板凳重試覆寫、legacy 設定同步、ready-check 計時器、閃卡階層順序等。
- `b4121f5` 兩階段分類器大改版：閃卡五分類 + 階層內二選一 PK（ELO）、LCU 真實開局卡片（subset champion list）、後端 ReadyCheck 自動接受、173 隻英雄清單、專屬 App Icon（G1~G8 的精華全在此 commit）。

### 2026-11-05（第 2 輪：系統匣與審計）
- `877a321` HANDOVER 文件更新（歷史文件，內容已被本檔取代）。
- `db1b199` 系統匣互動選單：狀態列（LCU/phase）、六個自動化開關、開啟主視窗、結束程式；可選 Windows 開機自啟（登錄檔 `LoLAramAssistant`）。
- `5acb835` 移除系統匣常駐選項；視窗啟動時同步 LCU 即時 phase。
- `4df8ad9` 25 項盲審缺陷：LCU WS 斷線重連與 lockfile 殘留 PID 檢查、等待期間不覆蓋手動選角、板凳倒數扣事件延遲、投降提醒冷卻/防呆、前端控制項持久化與 HTML 跳脫等。

### 2026-11-04（第 1 輪：基礎建設）
- `8a53110` 使用者實測三大缺陷：
  - **A 視窗拖曳報錯**：`capabilities/default.json` 加 `core:window:allow-start-dragging`；標題列 `pointer-events` 修正。
  - **B 大比拚重複英雄**：近期出場英雄去重 + 近期對決組合去重；aram/mayhem 各自獨立 ELO 與回合；不納入封印角色。
  - **C 清單混入經典模式英雄**：過濾 `Jade_*`（id ≥ 60000）、`TFT*`、id ≤ 0；`sanitize()` 清理舊設定。
- `51b61d4` 交接文件初版。
- `1e011bc` / `50644b7` tokio spawn 修正（watcher 移入 Tauri setup context、改用 `tauri::async_runtime::spawn`）。
- `fbfc521` 8 分鐘投降輪詢 + battle apply 流程。
- `4d60ae4` 設定持久化與選角規則測試套件。
- `7d337b3` 第二階段：設定持久化 + 選角規則引擎。
- `3ab9c6c` LCU 連線整合測試（`tests/lcu_live_test.rs`；沒有 LoL 客戶端時會以 ok 跳過）。
- `b79e690` 骨架 + Rust LCU 引擎（sysinfo 抓 port/token、自簽 HTTPS/WS）。
- `76beba1` Tauri v2 + vanilla-ts 專案初始化。

---

## 4. 資料流與資料檔（動設定前必讀）

### 4.1 AppConfig（真實設定）

- 位置：`%APPDATA%/lol-aram-assistant/config.json`（`config.rs`）。
- **帳號分檔（第 14 輪實作、第 15 輪改為每帳號一檔、第 16 輪截流競態守衛）**：設定跟隨目前登入的 LoL 帳號，**沒有主帳／副帳階層**——每個帳號都有自己的 `config-<puuid>.json`，3、4 個帳號都一樣，可各自獨立排序（例如小帳陪朋友玩輔助、大帳玩鬥士）。`accounts.json` 只記 `{"last_puuid": "..."}`（上次用的帳號，啟動時快速帶回該帳號設定）。流程：LCU 連線時後端呼叫 `GET /lol-summoner/v1/current-summoner`（`lcu.rs::fetch_current_summoner` / `parse_account_identity`）取 `puuid` 與 `gameName#tagLine`，帳號改變才重載對應檔案並推送 `config-updated` + `account-changed`、`record_last_puuid`；前端以 `get_active_account` 顯示帳號名與 pill（`index.html #accountPill`）。所有存檔路徑（`save_app_config`、`handle_tray_toggle`）都經 `ConfigManager::for_account(puuid)` 後才寫檔；未偵測到帳號時還原上次帳號的檔，無帳號紀錄時 fallback `config.json`（全新安裝）。**截流守衛（第 16 輪）**：前端 `saveConfigImmediate` 送 `expectedPuuid`（收集畫面設定時的 puuid），後端比對目前帳號不一致就拒寫並以 `lcu-log` 記錄「設定未寫入」；這擋的是切換當下 350ms debounce 存檔把舊帳號的 `profileList` 蓋進新帳號檔的競態。**第 17 輪原子性**：切換時在帳號寫入鎖內同時換帳號與設定（不會出現「新帳號＋舊設定」混合態）；`save_app_config` 與系統匣切換在整個操作過程中持有帳號讀鎖，切換路徑拿不到寫入鎖就排隊。雙重檢查（fast path + 鎖內覆核）避免兩個並發 sync 重複換載。鎖順序全程「帳號→設定」一致，無死鎖。**雙路觸發**：狀態連線事件 + LCU `/lol-summoner/v1/current-summoner` WS 事件（帳號在 LCU 連線不中斷時切換靠這條，實測主帳切換時 port 62036 不變、靠事件偵測到）。**CDP 實測**：錯 `expectedPuuid` 被拒且檔案未動；正確 round-trip 寫入成功；主帳 pill 正確顯示（名稱略），副帳檔（`config-<副帳 puuid>.json`）未被觸碰。**遷移紀錄**：舊 `config.json` 已改名為 `config-<副帳 puuid>.json`（副帳），`accounts.json` 已改寫為 `last_puuid` 格式；使用者之後換回主帳時主帳會開自己的新檔。**第 18 輪**：使用者要求把副帳的原始排序當種子複給主帳——`config-<副帳 puuid>.json` 整檔複製到主帳 `config-<主帳 puuid>.json`（CDP 實測：主帳 173/173 帶 `elo`、總場次 386、前三：伊澤瑞爾／法洛士／凱莎，副帳檔未動）。
- **一般 ARAM 與海克斯 Mayhem 共用同一份設定與排序（2026-11-08 第 12 輪合併）**：`aram_profile` 與 `mayhem_profile`、`aram_settings` 與 `mayhem_settings`、`ff_time_aram` 與 `ff_time_mayhem` 欄位仍保留在 JSON 以維持向下相容，但 `AppConfig::sanitize()` 每次都會把兩份清單統一為資料較完整的那一份（雙向補齊 `elo`/`matches`/`secondary_spell`/`flag`），並同步給另一份。前端（`src/main.ts`）只用單一共用狀態（`profileList`/`currentSettings`/`ffTime`）。任何寫入 profile 的路徑仍必須保留 `elo`/`matches`，與合併無關。
  ```json
  { "id": 81, "name": "英雄名", "tier": "本命", "flag": "", "elo": 1672.0, "matches": 5, "secondary_spell": 6 }
  ```
  - `tier`：`本命` / `愛角` / `順手` / `勉強` / `封印`。
  - `elo` / `matches`：**二選一大比拚的累積權重與出場次數**（`matches` 是「已比 N 次」）。Rust 端為 `Option<f64>` / `Option<u32>`，前端 PK 頁用它當初始權重；缺欄位時 PK 會重新 seed（1500 起跳），等於清掉歷史。**任何寫 profile 的路徑都必須保留這兩個欄位**。
  - `secondary_spell`（`Option<i32>`）：該英雄在此模式記憶的專屬副技能 ID（`6` 鬼步、`32` 雪球、`13` 清晰、`3` 虛弱、`14` 點燃、`21` 光盾、`7` 治癒、`1` 淨化）；未設定時走 `ModeSettings.default_secondary_spell`（預設 `6`）。主技能固定為閃現（`4`），由 `AppConfig.primary_spell_key`（`"D"` 或 `"F"`）決定放在哪一格。
- 主程式 UI 儲存、`sanitize()`、系統匣開關同步都會經過 `config.rs`；設定欄位變更要同步 `src/main.ts` 的 `collectConfig()/applyConfigToUI()` 與 `index.html`。

### 4.2 排序工作台的存檔鏈

```
mockups/algo-lab.html
   │  每次操作 persistNow()：POST http://127.0.0.1:18998
   ▼
mockups/autosave_server.py（或等價的臨時腳本）
   ├─ 寫 sorting-autosave.json          （lab 完整狀態：sessions + currentScope + profile）
   └─ 當 payload.profile 長度 > 50：
        ├─ 併入（或修復）AppConfig 後寫 %APPDATA%/lol-aram-assistant/config.json
        └─ 寫 aram-assistant-sorted-latest.json（repo 內的最新輸出快照）
```

- server 預設載入順序：live `%APPDATA%` 設定 → `aram-assistant-sorted-194rounds.json` → `aram-assistant-backup.json`。
- repo 版 server 額外做「權重補回」：payload profile 遺失某英雄的 `elo/matches`/`secondary_spell` 時，從 live 設定與兩個 rescue 快照依序補回，避免 lab 操作清掉 PK 歷史。lab 同步寫入 App 時，payload profile 會同時寫入 `aram_profile` 與 `mayhem_profile`（合併後的共用排序）。
- 無 server 時 lab 退化為純 localStorage（頁首徽章會顯示「已存於瀏覽器」），資料不進 App。

### 4.3 目前的 runtime 實例狀態（2026-11-07）

- **`127.0.0.1:18998`（lab 實際使用的 port）**：跑的是**舊的臨時腳本** `%TEMP%\opencode\autosave_server.py`（PID 21696，前一次 session 留下）。行為與 repo 版一致，差別只在沒有「權重補回」。使用者的權限設定把 `Stop-Process`、`taskkill`、`Remove-Item` 設為永久 deny，agent 無法替換它。
  - 想換成 repo 版：手動關掉那個 python 程序，然後 `python mockups/autosave_server.py`（見 §7）。
  - 不換也可以：lab 改版後的頁面會自己把 `elo/matches` 帶進 profile（見 §5 資料保存段落），舊 server 只是原樣寫入。
- **`127.0.0.1:18999`（本輪測試殘留）**：repo 版 server 的測試實例（PID 17572，`--root` 指向暫存目錄、`--no-appdata`），對真實資料無影響；使用者可自行關閉。
- **2026-11-07 的權重修復**：改版前的 lab 會把 `elo/matches` 從 profile 剝掉，導致 live 設定與 `sorted-latest` 一度 0/173 帶權重。已用一次修復 POST（把 `194rounds` 的權重依 id 併回 profile 後重送）補回：173/173 帶 `elo`，順序 digest 不變（`a250e778a0f8fb2f`）。
- **本輪 lab 改版前，使用者的 lab 分頁若還開著**：其記憶中的舊 JS 下次點擊仍會剝掉權重；請使用者重新載入分頁一次即可（之後頁面會帶權重）。萬一又被剝掉，重跑一次同型修復 POST 可再補回。
- **App 程序狀態（11/7 晚）**：App 已由 dev 鏈 rebuild 後自動重啟（新 PID 42928，21:51 啟動；舊 PID 31232 已退出），記憶體設定 = 11/7 定稿排序 + `ff_copy_clipboard=false`，程式碼含 `ad179e9`/`62d50c8`。注意舊的執行紀錄是記憶體資料，隨這次重啟消失。
- **ff 提醒延遲根因（11/7）**：poller 在 `2dce87c` 後已是 adaptive cadence（2s 平時、窗口 0.15–0.5s），偵測誤差 ≤~0.7s；主要延遲是前端 `playBeepAlert()` 每次都 new AudioContext（數百 ms 建立延遲、暫停狀態、瀏覽器同時 context 上限），`ad179e9` 改吃單一 session context + resume。桌面通知另有 Windows toast 顯示延遲（全螢幕遊戲時看不到），音效為主訊號。

### 4.4 repo 根目錄的四個 JSON（全部已在 `.gitignore`，只留磁碟）

| 檔案 | 用途 |
|---|---|
| `sorting-autosave.json` | lab 目前狀態（sessions 含二分期進度、undo 不含）。server 的 GET/POST 對象 |
| `aram-assistant-sorted-latest.json` | lab 最後一次同步進 App 的 AppConfig 快照（最新輸出） |
| `aram-assistant-sorted-194rounds.json` | rescue 快照：v2 PK 實驗室跑完 194 回合後的 AppConfig（權重來源、server fallback 之一） |
| `aram-assistant-backup.json` | rescue 快照：實驗開始前（11-06 23:07）的 AppConfig 備份 |

---

## 5. 排序工作台（`mockups/algo-lab.html`）

用途：用真實帳號資料（內嵌 51 場近期對戰 + 162 隻專精 + 173 隻英雄種子）快速決定「英雄優先序」，取代在主程式裡慢慢拖曳。兩欄介面：

- **左欄「Binary Divide 二分法」**：一次一隻「挑戰者」對上區間正中間的「守門員」。
  - 鍵盤：`←` 選挑戰者（排到守門員前面）、`→` 選守門員（挑戰者往後）、`↑` 差不多（並列收工）、`Space` 排本層第 1、`↓` 丟本層墊底、`Backspace` 復原。
  - 每層獨立進度（本命/愛角/順手/勉強 可排，封印只顯示）。
  - 「覺得放錯分類？」直接按下方按鈕把當前挑戰者移去別層。
  - 「↺ 重排本層」把該層整批重新二分。
- **右欄「五階層總覽看板」**：滑鼠拖拉微調順位與跨層移動（拖到某張卡左右半邊決定插前/插後）；「畫筆模式」點誰就進對應層；搜尋框過濾。
- **「初始分層產生器」**（頁首可展開）：以近期對戰權重（預設 55%）+ 專精分數（30%）+ 新鮮度（15%）自動初排，並可指定 本命/愛角/順手 人數（預設 16/36/55）。不滿意的話調整權重重跑，再用二分法/拖拉微調。
- **匯出/匯入 JSON**：匯出產生完整 AppConfig（可直接給主程式匯入）。匯入接受 AppConfig 或 profile 陣列。
- **資料保存**：每次操作 0.05 秒內 `persistNow()`：POST 到 server（→ 寫 `sorting-autosave.json` 並同步 App 設定）＋ localStorage 雙保險。頁首徽章會顯示寫入結果。載入順序：server 檔案 → localStorage → 內嵌種子。
- **`elo/matches` 保存**：`enrichChamp()` 與 `buildFlatProfile()` 會原樣帶著這些欄位；`sessions` 內也保留。勿在改版時拿掉這兩個欄位（`0b821c8` 前的版本就是在此踩雷）。
- **已知小限制**：拖到自己身上 = 取消（不動作）；同層拖曳索引已修正 off-by-one；拖到「挑戰者/等待佇列」的卡片位置時會夾到已鎖定區段尾端（設計如此）。

---

## 6. 目前狀態、已知風險、下一步

### 6.1 已驗證（2026-11-08）
- `cargo test --manifest-path src-tauri/Cargo.toml`：53 + 1（live LCU）全過；`pnpm tsc --noEmit`、`pnpm build` 皆成功（第 12 輪合併後）。
- GUI 以 WebView2 CDP 實測（第 13 輪）：兩 profile 173 筆且一致、主副鍵位與預設副技能即時寫檔、優先序拖曳換序即存且可還原、Console 無例外；驗證前後 `config.json` 逐鍵 diff 零差異。
- 系統匣「重新啟動」（`action_restart`，`AppHandle::restart()`）已上線：就地重啟二進位，不用手動關閉、也不會遺失設定（上次帳號的存檔保留在各自的 `config-<puuid>.json`）。
- 2026-11-07 舊紀錄：
- `cargo test --manifest-path src-tauri/Cargo.toml`：41 + 1 全過。
- `cargo test`（`cb00827` 之後）：41 + 1 全過、`pnpm tsc --noEmit` 成功。
- `cargo test`（`ad179e9`/`62d50c8` 之後）：41 + 1 全過、`pnpm tsc --noEmit` 成功、`pnpm build` 成功。
- App 套用：dev 鏈 rebuild→重啟後新 PID 12408（23:35 啟動），記憶體設定換成 11/7 定稿排序 + `ff_copy_clipboard=false`。
- GUI 修復：`vite` dev server 曾死亡（1420 無人聽，App 視窗壞掉），已重啟 vite 並觸發 App 重啟，窗口恢復載入。
- 種子快照：173 隻（本命 18 / 愛角 40 / 順手 62 / 勉強 43 / 封印 10）；與舊種子不同（1 隻從愛角換進本命 + elo/matches 更新）；round-trip 驗證 + `node --check` OK。
- `mockups/algo-lab.html` 內嵌腳本：`node --check` 通過。
- `mockups/autosave_server.py`：`py_compile` 通過；以暫存 root 端到端測試（GET 404 → POST → GET 回讀 → 匯出檔含權重補回、設定保留）。
- 權重修復後 live 設定：173/173 帶 `elo`，英雄順序 digest 與修復前一致，其餘 26 個設定鍵原樣保留。
- 11/08 今晨確認：App PID 12408 仍在跑、vite 200、GUI 正常；ff 複製實作關閉（開關仍在、預設 false）；trade 好友分類 log 與重抓已生效。

### 6.2 已知風險 / 未完事項
- **改版前的舊 lab 分頁若還開著**：舊 JS 仍可能在點擊時把 `elo/matches` 剝掉；關掉或 F5 即可（新開的頁面帶修正版）。
- **自訂測試未自動換角（11/7，使用者提問，未定論）**：當時條件檢查全通過（手上藍寶愛角 76、板凳雷茲本命 94、分差 +18 ≥ 門檻 10、無 🔒/⛔、master 與 auto_bench 皆開），未換的可能原因：`manual_bench_hold` 被手動改角觸發（`987b6ef` 的「尊重手動」設計）、自訂房 swap 端點全部被拒、`benchEnabled=false`。已在 `cb00827` 補上 skip/失敗紀錄；重跑一次側欄「▶ 測選角」即可在執行紀錄看到 exact reason。`ad179e9` 進一步補上好友分類 log 並修 allies 空集合快取（tr.allies_fetch_attempts 最多重抓 3 次），下次重跑可從執行紀錄直接看出是「識別失敗」還是「分類成功→manual」。
- **ff 延遲根因（11/7）**：poller 在 `2dce87c` 後已是 adaptive cadence（2s 平時、窗口 0.15–0.5s），偵測誤差 ≤~0.7s；主要延遲是前端 `playBeepAlert()` 每次都 new AudioContext（數百 ms 建立延遲、暫停狀態、瀏覽器同時 context 上限），`ad179e9` 改吃單一 session context + resume。桌面通知另有 Windows toast 顯示延遲（全螢幕遊戲時看不到），音效為主訊號。
- **ff 複製已關閉（Riot 擋遊戲外貼上）**：預設 `false` + live 設定已改；App 記憶目前為 false（重啟後載入）。開關仍在投降提醒設定頁供使用者手動改回。
- **GUI 白屏檢查**：App 視窗漆黑/空白且 `Get-NetTCPConnection` 看不到 1420 在聽 → dev server 死了。復原：`pnpm dev`（背景）讓 vite 回來，再 bump `src-tauri/src/lib.rs` mtime 觸發 dev 鏈重啟，或在 App 按 F5。案 30552（pnpm tauri dev）與 40592（tauri-cli）活著即足以用此復原。
- **live server 是舊臨時腳本**（見 §4.3）：功能足夠；換成 repo 版需要使用者手動關掉舊程序（agent 被權限設定禁止終止程序）。
- **測試 server（PID 17572, port 18999）**還在跑：無害，可關。
- 沒有 git remote、`git push` 被 deny：不要把「已推送」寫進任何報告。

### 6.3 下一步候選（未經使用者拍板前不要動）
1. **總覽改版實作**：已完成（三欄版面 + 手動搶角安全連點保護，見 §3 第 9 輪），待使用者實際遊玩回報體驗。
2. **召喚師技能自動選擇（B+A 方案）**：已完成（D/F 主副鍵位切換 + 鬼步/雪球常駐與其他技能展開選單 + 依英雄自動記憶副技能，見 §3 第 10～11 輪），待使用者實際遊玩回報體驗。
3. **ARAM／Mayhem 合併（#12 輪）**：已完成（標題列切換鈕與複製按鈕已移除，共用單一 `profileList`；`config.rs` 同步鏡像寫入兩 sides 以維持外部工具相容），待使用者確認兩邊顯示一致。
4. **新增需求討論（待使用者確認細節後動工）**：帳號綁定紀錄（第 14 輪主副設計實作 CDP 驗證通過；**第 15 輪改為每帳號一檔、拿掉主副階層**；**第 16 輪加截流守衛擋切換競態**）：每個帳號 `config-<puuid>.json`，`accounts.json` 只記 `{"last_puuid": "..."}` 供啟動還原，`cargo test --lib` 59 項、`tsc`、`build` 通過（`test_phase_elapsed_ms_counts_from_phase_start` 為既有 flaky 計時測試，偶發 ±1ms 失敗、重跑通過，與本輪無關）。遷移已完成：`config.json` → `config-<副帳 puuid>.json`，副帳檔 CDP 實測（173 位 `elo` 完整、存檔寫回副帳檔、無 `config.json` 重建、逐鍵 diff 僅一筆正常 `secondary_spell`）。待使用者下次結束 App 後重編第 16 輪二進位並重開，換回主帳時驗證：主帳新檔建立、pill 更新、`expectedPuuid` 守衛拒寫。
5. 若使用者想把 Binary Divide 工作台搬進主程式「英雄優先序」頁（取代或補充現行拖曳+閃卡+PK），是後候補。
6. 任何改變 `aram_profile` / `mayhem_profile` 欄位結構的改動：先更新 §4.1 與 `AGENTS.md`。

---

## 7. 驗證與啟動指令

```powershell
# 主程式驗證
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tsc --noEmit && pnpm build
pnpm tauri dev                 # 桌面開發模式

# 排序工作台
python mockups/autosave_server.py     # 預設 port 18998、root = repo 根目錄
# 測 server 不碰真實資料時：
python mockups/autosave_server.py --port 18999 --root <temp_dir> --no-appdata
# 然後以瀏覽器開啟 mockups/algo-lab.html
```

---

## 8. 工作公約（歷史與現行）

- **絕不**加入遊戲內輸入模擬；只用 LCU API / Live Client 唯讀資料。
- 修 profile 相關路徑時保留 `elo/matches`（見 §4.1）。
- 動到前端或 Rust 共用模組：跑 §7 兩組驗證；只動 `mockups/`：至少 smoke test 受影響頁面。
- Commit：Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:`），一個里程碑一個 commit；本 repo 無 remote，不推送。
- 使用者反饋的缺陷一律視為最高優先，修完把根因寫回本檔對應段落。

---

## 9. 第 9 輪交接（2026-11-09）

- **前端改版（B1）已正式實作並驗證**：導覽 9 項收斂為 5 項（總覽／自動化／英雄／紀錄／設定），自動化四頁（對戰與選角／換角規則／換角發話／投降提醒）合併為一頁六區塊；總覽改主視覺放大、不對稱排版、換角請求只在待手動決定時出現 alert banner、紀錄只剩一行；設定控件統一幾何（同高分段控件、統一滑桿、數值欄等寬）；拿掉副敘事（後端判定等）、版本號、底部重複說明。滑桿填色已用 `--p` 漸層對齊圓柄中心並實測正確。
- **產品命名**：「聊天訊息」改「換角發話」；投降提醒誠實定位為僅提醒（Riot 擋貼上，無法自動送）。
- **Dev 環境**：`tauri.conf.json` devUrl 與 `vite.config.ts` port 已對齊 1421；Windows `windows_subsystem` 改恒隱藏（dev 版也不再彈 console）。後端邏輯零改動；設定欄位結構不變。
- **下一步**：B2（`main.ts` 約 2600 行拆模組）未開工；push 到 GitHub 前跑 `docs/REBUILD.md` 清單。
