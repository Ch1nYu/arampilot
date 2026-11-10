# 專案規格書：LoL LCU 輕量自動化助手 (Safe & Lightweight LCU Assistant)

> **交接對象：** 自動化程式碼生成 Agent / 軟體工程師  
> **專案目標：** 開發一款不觸發 Riot Vanguard 反作弊系統、記憶體佔用極低、具備現代化深色毛玻璃質感 GUI 的《英雄聯盟》大廳輔助工具。

---

## 1. 安全與合規紅線 (CRITICAL CONSTRAINTS)

Agent 在實作任何程式碼時，**必須嚴格遵守以下安全邊界**，以確保帳號零封鎖風險：

1. **禁止記憶體讀寫與注入：** 嚴禁讀取或修改 `League of Legends.exe` 記憶體、嚴禁注入 DLL 或修改官方/第三方（如 Blitz）執行檔。
2. **禁止遊戲內模擬輸入 (No Simulated Input In-Game)：** 進入遊戲畫面後，**嚴禁**使用 `SendInput`、`keybd_event`、`PyAutoGUI` 或任何虛擬驅動自動發送按鍵（如自動輸入 `/ff`）。Vanguard 會將此行為直接判定為腳本（Scripting）。
3. **純 API 互動原則：**
   * **大廳階段 (`LeagueClientUx.exe`)：** 100% 透過官方本地 **LCU (League Client Update) API** 與 **WebSocket** 進行操作。
   * **遊戲內階段 (`League of Legends.exe`)：** 100% 僅讀取唯讀的 **Live Client Data API (`https://127.0.0.1:2999`)**。
