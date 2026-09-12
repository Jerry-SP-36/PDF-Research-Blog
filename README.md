# PDF Research 0.6.2

輸入主題，由 Codex 操作 PDF Search，閱讀相關本地 PDF、核對畫面、擷取原圖，並可選擇以即時 Web Search 補充官方或近期資料，整理成繁體中文研究報告。

## 開始使用

1. 開啟同一層的 **PDF Research.app**。
2. 等待「研究環境已就緒」，輸入主題。
3. 選擇 Codex 模型、思考深度與資料範圍，按「開始研究」。預設 GPT-5.6 Luna／high、僅本地 PDF；需要近期或官方線上狀態時可選「本地 PDF ＋ 即時網路」。PDF 文件預設「不限（依涵蓋度）」，也能固定 3–10 份；圖表預設「不限（依論點）」。
4. 保持 App 開啟。研究時 PDF Search 會切換文件與頁面，請避免同時操作它。
5. 在右側閱讀報告；點圖可放大，PDF 引用會開啟本地文件，網頁引用會交由預設瀏覽器開啟。也可以下載 Markdown。
6. 研究結束後，在「本機偏好記憶」記錄這次做對的內容、需要修正的錯誤與長期偏好；下一次相關研究會取用這些經驗。

使用 `Command +` 放大整套介面、`Command -` 縮小、`Command 0` 回到 100%；也可從「顯示」選單操作。倍率以 10% 調整，範圍 70%–200%，關閉 App 後仍會保留最後設定。視窗寬度不會再偷偷改變倍率，窄視窗只使用響應式版面重排。

研究一次執行一個，新工作會排隊；可同時保留最多 10 個進行中或等待中的研究。可以取消；中斷時保留已蒐集資料，重新開啟不會自動重跑。指定數量未達或關鍵問題未解時會標記「部分完成」，不補造資料。

「不限（依涵蓋度）」是一般研究的建議值：依相關性、互補證據與關鍵問題涵蓋度繼續搜尋，沒有隱藏的文件或圖片上限。搜尋不再增加實質內容、現有索引沒有更多相關資料，或需在 45 分鐘上限內收尾時，記錄實際原因。需要控制耗時或以相同規模重現比較時，可固定 3–10 份。更多篇數不一定代表更完整。

模型清單即時讀取此帳號的 Codex catalog，只列可看圖片的模型。選擇的是目前可用 model ID；只有清單有提供的版本才能指定，不能保證固定到未提供的日期快照。任務會顯示選定與實際使用模型；不支援的模型／思考深度、模型被切換時會停止並回報，不自動升級 Astra。歷史任務未記錄模型時顯示「當時預設」。

## 本機偏好記憶

每個完成、部分完成、失敗、取消或中斷的任務都會自動保存流程結果。系統的「完成」只代表報告通過既有結構與檔案檢查，不代表技術內容已由人判定正確。任務頁可另選「尚未判定／正確／部分正確／錯誤」，並填寫三個可修改欄位：

- 「做對／希望保留」和「錯誤／下次要修正」只在相近主題被取回。
- 「我的長期偏好」可跨主題套用；若內容衝突，以較新的相容回饋為準。
- 新任務會顯示啟動時實際取用了幾則偏好與相近經驗。當次使用的內容在建立任務時凍結，執行途中不會被另一個編輯改寫。

經驗檔保存在 App 同一層的 `pdf-research-data/experiences.json`，不收入 Git repository。下一次執行研究時，相關回饋會隨提示送給 Codex；原始 PDF 與研究證據仍需重新核對，經驗不會取代來源事實或操作權限。

這個功能採用「保存 → 依主題取回 → 放入提示 → 重新驗證」的方式讓模型遵循偏好，沒有修改模型權重。OpenAI 的正式 fine-tuning 是另一套流程，需要準備訓練資料並建立 fine-tuning job；本 App 沒有啟動該流程。參考：[模型提示與評估指引](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-4.1)、[Fine-tuning API](https://developers.openai.com/api/reference/resources/fine_tuning)。

## 閱讀記憶

App 會把每次實際讀過的 PDF、檔案 SHA-256、當時頁數、頁碼、該組頁面涵蓋的具體主題、搜尋詞、摘要、條件與發現保存到 `pdf-research-data/reading-memory.json`。研究進行中，Codex 每讀完一組有用頁面就寫入；通過驗證的報告也會為每個 PDF 來源各回填一筆記錄。超出實際 PDF 頁數的記錄會被拒絕。任務畫面顯示本次新增與啟動時取用的筆數。

新研究只取回與主題有詞彙關聯且 PDF 雜湊未變的記錄，用來直接定位可能相關的頁面。記錄只表示那些頁面曾讀過，不會把整份 PDF 標成「已讀」；同一份多主題 PDF 遇到新問題時，仍須搜尋與閱讀其他段落。所有本次要引用的頁碼與原圖仍須重新在 PDF Search 顯示並截圖核對，舊摘要不能直接充當新報告證據。

## 即時網路補充

選擇「本地 PDF ＋ 即時網路」後，每一任務只在該 Codex thread 把內建 Web Search 設為 `live`；本機 shell 仍保持無網路權限，外部 connectors 仍關閉。流程會先做具體查詢，再開啟最相關的官方、標準團體、供應商規格或原始研究頁面；搜尋摘要本身不算可引用來源。

網頁來源需保存正式標題、精確 HTTPS URL、存取時間與可取得的發布／更新日期。App 另行計數 PDF 與網頁來源，只接受本次 Web Search 實際開啟過的 URL；網頁沒有虛構 PDF 頁碼，也不能提供報告原圖或滿足 PDF 文件目標。Web Search 用於補充近期狀態、標準更新與勘誤，本地 PDF 仍是圖文研究主體。

## 本版範圍

- 預設只使用 PDF Search 既有索引與本地 PDF；每個任務可選擇加入 Codex 即時 Web Search。
- 分析段落、表格及圖片旁附來源連結；PDF 保留頁碼，網頁保留精確 HTTPS URL 與存取日期。
- 原圖穿插正文；逐頁蒐集紀錄留在工作資料，不列入研究報告。
- 報告與圖檔保存在 App 同一層的 `pdf-research-data/jobs/`，在歷史清單可再次開啟。
- 研究流程結果與使用者回饋保存在 `pdf-research-data/experiences.json`，未來任務只取用長期偏好與相近主題經驗。
- PDF 頁面閱讀記錄保存在 `pdf-research-data/reading-memory.json`；依主題與未變檔案取回，引用仍重新核對。
- 不產生或發布部落格草稿。

原始 PDF、Obsidian、全域 Skills 與設定保持唯讀。App 透過目前已登入的 Codex 帳號工作，使用該帳號的模型與用量；分析所需的文字與畫面會由 Codex 傳給模型，本機介面不代表模型在本機執行。

## 執行環境

這是針對目前這台 Apple silicon Mac 打包的個人 App（macOS 13.5+），依賴已安裝的：

- Codex／ChatGPT App 內建 Codex CLI，目前採 `/Applications/ChatGPT.app/Contents/Resources/codex`。
- Codex 已登入、Computer Use 工具可用及必要的 macOS 操作權限。
- PDF Search 與 `~/.codex/skills/pdf-search-topic/SKILL.md`。
- Codex workspace runtime 中的 Node.js 22+、Python/Pillow、Poppler。

「研究環境已就緒」表示檔案、登入與工具載入檢查通過。PDF Research 會自動允許目前研究執行緒透過 Computer Use 操作 PDF Search；這項永久設定只涵蓋訊息、工具、App、執行緒與空白授權表單完全相符的請求。需要操作其他 App、取得額外權限或補充關鍵資訊時，介面仍會顯示具體請求。

目前允許的 PDF 根目錄：`~/Library/CloudStorage/OneDrive-個人/Reference`。只服務已被報告列出的 PDF 與圖檔，不提供任意檔案瀏覽。網頁連結只允許 HTTPS，並由 macOS 預設瀏覽器開啟。

## 開發與維護

原始碼在此資料夾。無 npm 套件依賴。

```sh
node server.mjs
node --test tests/*.test.mjs
node build-app.mjs
node package-app.mjs
```

第一個命令會輸出僅限本機的啟動網址。一般使用直接開啟 App 即可。

`build-app.mjs` 重建同一層的 Universal 2 App，明確編譯 `arm64` 與 `x86_64` 兩個原生切片、合併後驗證架構與 macOS 13.5 deployment target，再簽署本機 ad-hoc 簽章。這可避免從 Rosetta 或不同主機重建時意外退回 Intel-only；目前工作流程使用的 Node runtime 最低版本也是 macOS 13.5。請先結束 App 再重建。若需要自訂路徑，可在原始碼根目錄新增 `config.local.json`；打包版本則放在 `PDF Research.app/Contents/Resources/app/` 後重簽。不要把私密憑證放入設定。

`package-app.mjs` 產生同一層的 `PDF Research.zip`，移除 File Provider 自動附加的 Finder 中繼資料，並在來源 App、封裝暫存與 ZIP 解壓讀回三個階段驗證 Universal 2、macOS 13.5 target 與簽章。這是本機個人版封裝，依賴上述現有環境。雖然 launcher 也包含 `x86_64` 切片，完整 Intel 流程仍需要另備相容的 Node、Codex、Python 與 Poppler，因此本版的實際驗收範圍是 Apple silicon。

## 驗證與限制

先前 v0.2.0 曾以 Luna／high 實跑原來的 224G via stub 題目；流程完成，但人工內容驗收未通過：發現引用頁碼錯配、部分原圖不清楚及設計門檻適用條件不足。因此目前不能宣稱 Luna 已達到原 Astra 範例品質。v0.6.0 另以隔離 QA 任務驗證即時 Web Search 與閱讀記憶的保存／取回，但沒有再完成一份全新研究報告；v0.6.1 調整原生 App 的建置與封裝架構；v0.6.2 將固定 PDF 上限擴至 10，並明示圖表不限。詳細案例、已修正項目與下一步見 [Luna 實測與修正建議](EVALUATION.md)。介面的「研究完成」代表任務與自動檔案／結構檢查完成，不等於獨立技術審查通過。

已包含任務生命週期、取消／斷線、HTTP 存取、來源與圖檔邊界、SHA-256 去重、引用與頁面關係、HTML escaping 等測試。報告提交時另外讀取 PDF 真實頁數、解碼圖檔，並把渲染結果寫入後讀回比對。

App 記錄實際 Computer Use 操作與不重複的截圖結果。這能確認有操作與圖像證據，但逐頁畫面對應及技術解讀仍由研究 Agent 核對，不宣稱程式能自動證明每個結論正確。

單次研究預設最多 45 分鐘。單次 Computer Use 操作超過 3 分鐘，或連續三次操作失敗，會停止並保留資料；不會自動強制結束 PDF Search。若 Codex 用量耗盡、PDF 不在允許的目錄、來源不足或操作權限失效，介面會保留具體狀態；不會把檢查成功視為研究完成。

架構採 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 stdio JSON-RPC，使用現有登入與工具；沒有另存 API key，也不修改全域 Codex 設定。
