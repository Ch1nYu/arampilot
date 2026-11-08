# lolafk — LoL ARAM / Mayhem 輕量助手

Tauri v2 + 原生 TypeScript 的《英雄聯盟》ARAM 與 ARAM: Mayhem 個人化助手：開局自動接受、英雄卡自動選擇、板凳搶角、隊友換角判定、系統匣常駐、8:00 投降提醒，以及「二選一大比拚」ELO 排序。

開發脈絡、目前進度、資料流與下一步都在 **[HANDOVER.md](HANDOVER.md)**，動工前先讀。

## 快速開始

```powershell
pnpm install
pnpm tauri dev        # 桌面開發模式
```

排序工作台（搭配 mockups/autosave_server.py 可將排序結果直接寫入 App 設定）：

```powershell
python mockups/autosave_server.py
# 然後用瀏覽器開 mockups/algo-lab.html
```
