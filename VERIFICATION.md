# PDF Research 驗證紀錄

## v0.6.2 — 2026-09-12（台北）

- 固定 PDF 數量由 3–8 擴充為 3–10，圖表預設值明示為「不限（依論點）」；`null` 仍是依論點取圖，不會回落成舊的固定八張。進行中與等待中的研究可同時保留 10 個，第 11 個會明確拒絕。
- 完整測試 73 項通過、0 失敗／跳過；包含固定 10 份接受、11 份拒絕、10 個 active jobs 可排入與第 11 個拒絕。語法檢查與 `git diff --check` 通過。
- 正式 App 與 ZIP 解壓副本均讀回版本 0.6.2、`x86_64 arm64`、兩個 slice `minos 13.5`、`LSMinimumSystemVersion 13.5` 與有效的 all-architectures 簽章；ZIP 解壓副本另通過 strict 驗證。13 個執行資源的檔名集合及 SHA-256 內容均與原始碼一致。
- ZIP 為 135,726 bytes，SHA-256 `7c153fa93e3aad07ba80391a62362bbfdcc1ffcabb8a2fe55d8674cd7de819bd`。機器讀回見 [verification-v062.json](verification-v062.json)。
- 已安裝 App 的 UI 真實讀回「研究環境已就緒」、Luna／high、本地 PDF、10 份 PDF 及「不限（依論點）」。介面建立十個不同 SI／PI 主題；十份任務檔都讀回 `sourceCount: 10`、`figureTarget: null`、Luna／high 與本地 PDF。
- 第一個 FEC 任務曾完成 15 次 Computer Use、10 張 PDF Search 畫面核對並保存兩筆閱讀記憶；之後 PDF Search 程序異常佔用約 98% CPU，三次操作逾時而誠實失敗。正常終止該單一程序後，CUA 重開 PDF Search，讀回 4,924 份文件／4,835 份已索引，後續共振題重新取得頁面與截圖。via-stub 的失效嘗試在改採無 App 證據的輔助流程後由操作端取消，沒有把它算成有效暖機。
- 為避免重啟將進行中與排隊任務標成 interrupted，已安裝且正在跑批次的 App 暫不覆寫；它和本版正式資源只差 active queue 上限仍為八。正式 App／ZIP 已包含十個 active jobs 的修正。批次研究是非同步長任務；上述證據只確認參數、排隊、真實 PDF Search 讀取及閱讀記憶落盤，不宣稱十題都已完成或通過技術審查。

## v0.6.1 — 2026-09-12（台北）

- 原本的 Swift launcher 沒有指定 target，會繼承建置程序的主機架構與系統版本；這讓 Rosetta／Intel 環境可能產生 Intel-only App，且本機稽核時 Mach-O `minos 26.0` 與 Info.plist 宣告 13.0 不一致。
- 建置改為分別編譯 `arm64-apple-macos13.5` 與 `x86_64-apple-macos13.5`，再以 `lipo` 合成 Universal 2。macOS 13.5 與目前外部 Node runtime 的最低版本一致；target 與 `LSMinimumSystemVersion` 由同一常數產生。
- 建置與封裝會在 post-lipo、正式簽章、乾淨 staging 及 ZIP 解壓讀回階段檢查精確架構集合、兩個 Mach-O slice 的 `minos`、Info.plist 最低版本及 all-architectures 簽章；架構或版本漂移會直接使建置失敗。
- 正式 App 與 ZIP 解壓副本均讀回 `x86_64 arm64`、兩個 slice `minos 13.5`、`LSMinimumSystemVersion 13.5` 與版本 0.6.1。解壓副本通過 `codesign --verify --all-architectures --deep --strict`；原位 App 仍受 File Provider FinderInfo 影響，只作非 strict 驗證。
- 完整測試 72 項通過、0 失敗；語法檢查與 `git diff --check` 通過。正式 App 與 ZIP 解壓副本各有 13 個執行資源，檔名集合與 SHA-256 內容都和原始碼一致。
- ZIP 為 135,685 bytes，SHA-256 `48c362181198e215dfb4580a056f3aaa70af706355ef4bdb89ca4b12b31e0e21`。機器讀回見 [verification-v061.json](verification-v061.json)。
- 正式 UI 啟動驗收重試兩次，CUA 都回報 Mac 仍鎖定，因此未能讀回畫面，不能宣稱已由 UI 證明警告消失。Apple M3 上已完成原生 `arm64` Mach-O、雙 slice 版本與 all-architectures 簽章驗證。目前只驗收 Apple silicon；Universal launcher 雖包含 `x86_64`，外部 Node、Codex、Python 與 Poppler 的 Intel 版本及 Intel E2E 尚未驗證。本機 ad-hoc 簽章也不是 Developer ID 公開散佈流程。

## v0.6.0 — 2026-09-12（台北）

- 新增 `reading-memory.json`：實際閱讀頁群保存 PDF SHA-256、真實頁數、頁碼、頁面主題、查詢、摘要、條件與發現。同一 PDF 內容與頁群會合併歷次主題及任務，不重複占滿取回額度；檔案雜湊改變的舊記錄不取用，失效高分記錄也不會擋住後續有效記錄。
- 報告回填只保存帶 `pdf-search-screenshot` evidence 的頁，`pagesRead` 中未核對頁不會被標成已讀；超出 `pdfinfo` 真實頁數的動態記錄會被拒絕。排隊任務在真正開始前重新取回最新記錄。隔離 QA 真實保存《Next Generation CEI-448G Framework》p.33–34 與五個具體主題；第二個相關任務啟動時取用 1 筆，重建並重開 QA App 後仍讀回 1 筆。
- UI 可選「本地 PDF」或「本地 PDF ＋ 即時網路」。後者只在該 thread 設 `web_search=live`，本機 shell 網路與外部 connectors 仍關閉。兩個 QA 任務分別收到 4 與 2 個 Web Search 結果事件，且產生官方近期資料，但都在開啟可引用頁面及完成報告前取消；因此不宣稱已有完整 Web 報告。最終 gate 只計成功的 completed 搜尋，且每個網頁引用必須匹配當次成功 `openPage` 的精確 HTTPS URL；失敗、錯誤、`findInPage` 或不安全 URL 不能通過。
- PDF 文件數預設「不限（依涵蓋度）」並明示為一般研究建議；以問題支持度、內容飽和、來源用盡或 45 分鐘邊界停止。固定 3–8 份保留給控時或可重現比較。
- 完整測試 72 項通過，0 失敗／跳過；包含閱讀記憶合併、SHA freshness、真實頁數邊界、只回填 evidence 頁、失效候選不阻塞、排隊刷新、重啟讀回、每任務 Web 模式、失敗 Web 事件與 exact opened URL，以及既有任務／HTTP／報告安全回歸。
- 正式 App 讀回 `v0.6.0`、「研究環境已就緒」、PDF 頁碼工具、兩種資料範圍、預設不限與五個既有歷史任務。13 個執行資源與原始碼逐位元組一致；App 已留在畫面供使用。工作區 File Provider 會重新附加空 FinderInfo，因此原位 App 通過一般簽章驗證，乾淨 ZIP 解壓副本才作嚴格簽章驗證。
- ZIP 為 104,270 bytes，SHA-256 `a9d637e362d82dcdae1ad05c97e8d1458a39fd02993382465e6b7d79e2da9621`；解壓後版本 0.6.0、13 個資源零差異並通過 `codesign --verify --deep --strict`。機器讀回見 [verification-v06.json](verification-v06.json)。
- 本版尚未完成第二次「取用舊頁後仍為同 PDF 新主題另行搜尋」的完整 Agent 研究，也沒有完成含網頁引用的新報告；相關的非略過、重新翻頁與 exact-open 契約已有測試，這兩項仍保留為實跑限制。

## v0.5.2 — 2026-09-11（台北）

- PDF Research 會自動接受目前執行中研究由 `cua_repl` 發出的精確 PDF Search 空白授權表單。比對包含方法、server、目前 thread、完整訊息、object schema、零 properties 與零 required fields；不同 App、server、thread、方法、訊息、schema 或已結束任務仍進入既有人工核准流程。
- 隔離 QA App 真實執行「FEC 技術定義」研究：連續 6 個 PDF Search 授權請求全數自動接受，沒有進入 `needs_input`、待處理請求維持 0；第一個 Computer Use 呼叫完成後才由測試端取消任務。App 介面逐項讀回自動允許事件。
- 完整測試 60 項通過，0 失敗／跳過；涵蓋每次自動接受、所有近似但不相符請求、跨任務套用、重啟資料邊界、已關閉任務、取消競態，以及非 PDF Search 授權仍會暫停操作逾時計時器。
- 正式 App 讀回「研究環境已就緒」、「PDF Search 已安裝；PDF Research 已設為自動允許操作」與 `v0.5.2`；五個既有正式研究仍可讀取。12 個執行資源與原始碼逐位元組一致。
- ZIP 重新解壓後通過嚴格簽章驗證，SHA-256 為 `a03e7cc4da0ca130b7a4e1e8a11bcf7ffd7ff01a0a3872405f1d8a1000e84a86`。機器讀回見 [verification-v052.json](verification-v052.json)。

## v0.5.1 — 2026-09-11（台北）

- 已移除依視窗寬度自動縮放。原生「顯示」選單提供 `Command +`、`Command -`、`Command 0`；範圍 70%–200%、每次 10%。Computer Use 實際讀回 100% → 110% → 100%，另將 QA App 設為 120%、結束後重開，選單仍讀回 120%；正式 App 以 `Command 0` 重設並讀回 100%。
- 每個終止任務自動寫入流程狀態；任務頁可選「尚未人工判定／正確／部分正確／錯誤」，並保存做對、錯誤修正、長期偏好三欄。相近題目只取用相關做法、修正與流程失敗；長期偏好可跨題目取用。注入規則明定需重新核對本次 PDF，不能覆蓋來源、權限與報告契約。
- QA App 以一個模擬失敗任務驗證完整介面：畫面顯示流程失敗與人工判定欄位；透過介面儲存三種回饋後，畫面讀回「已儲存」，`experiences.json` 也逐字讀回三個值與失敗原因。重啟、相近題目選取及下一任務 `workflow.txt` 實際含回饋另由自動測試驗證。
- 正式 App 首次開啟後，從既有五個歷史任務自動建立五筆經驗，狀態讀回為兩筆完成、三筆取消；使用者判定均保持 `unreviewed`，沒有把流程完成猜成技術正確。檔案權限讀回為 `0600`。
- 完整測試 61 項通過，0 失敗／跳過；包含經驗資料持久性、輸入上限、人工判定、錯誤案例取回、提示注入、終止狀態限制、同源 API 與所有既有任務／報告安全測試。
- 正式 App 的版本讀回為 0.5.1；12 個執行資源與原始碼逐位元組一致。ZIP 經重新解壓及嚴格簽章驗證，SHA-256 為 `756a4315ade747aad8857ddbf52ff52af33a6d190853e2adc37a41f7e492b2e3`。機器讀回見 [verification-v051.json](verification-v051.json)。
- 這套經驗機制是可檢視的本機資料與 prompt retrieval。它會在未來研究執行時把相關內容送給 Codex，但沒有建立 fine-tuning job，也沒有改變基礎模型權重。

## v0.5.0 — 2026-09-11（台北）

- 主視窗會依可用寬度自動將整套介面放大 115%–135%；縮小視窗時仍由既有響應式斷點重排，避免只放大文字造成控制項與版面失衡。

- 完整測試 56 項通過，0 失敗／跳過；新增模型選擇與實際值讀回、自動數量與 coverage 契約、工具失敗／超時、等待許可期間暫停操作計時器等案例。本機 HTTP 測試需允許綁定 127.0.0.1，已在允許環境重跑通過。
- App 重建後再次開啟，讀回 Luna／high、自動文件／自動圖表，以及既有任務與實際模型欄位。模型選單實際顯示 Astra、Sol、Terra、Luna、5.5。
- 截圖確認藍色主視覺；從最新報告點引用，實際顯示 IEEE 文件第 24 頁；點圖可放大並顯示來源與圖說。
- 執行資源與交付原始碼逐位元組一致，ZIP 重新解壓後通過嚴格簽章檢查。原範例報告與八張圖的既有雜湊全部保持不變。機器讀回紀錄見 [verification-v05.json](verification-v05.json)。
- Luna 同題自動模式真實完成 2 份來源／3 張圖；程式檢查通過，但人工內容驗收未通過。**不以程式測試、結束狀態或圖片數量證明技術品質。** 失敗稿、原因與待實作建議見 [EVALUATION.md](EVALUATION.md)。
- 最後追加的 App handle／新 AX 索引指令，以及許可計時器暫停修正，已納入交付版；後者有程式測試。尚未再執行第三次完整 Luna 研究，不能宣稱後續模型行為已改善。

## v0.1.0 — 既有紀錄

驗證日期：2026-09-10T15:17:24.832Z

- 41 項程式測試全部通過，無跳過或 TODO。涵蓋任務生命週期、取消與斷線、單次研究許可、HTTP 與來源檔案邊界、引用及圖檔驗證。
- 10 個 App 執行資源檔與交付原始碼逐位元組一致。
- ZIP 已在獨立暫存目錄重新解壓，通過 codesign --verify --deep --strict。

## 實際介面到報告

主題：224G PAM4 的 via stub 對 SI 影響、背鑽殘留長度與製程公差設計建議
建立：2026-09-10T14:55:09.870Z
完成：2026-09-10T15:09:44.898Z

- 從原生 App 輸入主題並啟動，使用真正的 Codex app-server 與 PDF Search。
- 25 次實際 Computer Use 操作、9 個不重複的頁面截圖；產出 3 份不同 PDF 來源、8 張原圖。
- 原圖已逐張檢視；PDF 頁碼、檔案雜湊、圖像解碼、引用及報告讀回皆通過，驗證錯誤與警告為空。
- App 結束後重開，完成狀態、報告與歷史清單仍可讀取。
- 從引用開啟本地 Intel PDF，畫面實際位於引用的第 26 頁。
- 在報告點原圖，成功顯示放大視窗、圖說與來源。
- 透過下載按鈕與 macOS 儲存面板保存 Markdown，下載檔與原報告完全相同。

下載檔 SHA-256：5d0b5a6865571a03cfcc58f3a44779fbc1f47865da8836873b1519f9203121ac

首次連線測試因重複詢問 PDF Search 許可而取消，該紀錄保留；修正後的新任務完成上述驗收。

此證據確認此台 Mac 的實際執行流程與本次成果；不代表每個未來主題的資料充分性或技術結論都已經獨立驗證。
