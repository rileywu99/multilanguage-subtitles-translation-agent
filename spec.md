# Translation Agent — Technical Spec

> 本文件根據現有 code 反推(`src/lib/*.ts`、`src/app/api/translate/route.ts`),記錄實際運作方式,而非行銷簡報上的概念版流程。
> 線上體驗: https://translation-agent-rho.vercel.app

## 1. 定位

多語言 CSV 翻譯工具。使用者上傳 CSV,系統自動判斷哪些欄位需要翻譯、抓取內容領域與語氣、批次翻譯,並在輸出前做防呆檢查,最後下載一份「原欄位 + 新語言欄位」的新 CSV。

**重要澄清**:目前實作是**單一 API route 內依序呼叫的 4 個 function**,不是 4 個獨立的 Claude Code subagent。沒有 `.claude/agents` 設定,沒有 agent 對 agent 的 delegation。「4 步驟」是 pipeline 階段的命名,不是多 agent 架構。

## 2. Pipeline(對應 `route.ts` 的實際執行順序)

```
CSV text
  │
  ▼
① parseCsv()                     src/lib/csv.ts
  │  Papa Parse 解析成 { headers, rows }
  ▼
② detectSourceLanguage()         src/lib/csv.ts
   detectTranslatableColumns()
  │  規則式判斷(Unicode 區間 + 詞組偵測),不呼叫 LLM
  │  - CJK/Kana/Hangul 或「英文詞組」(2+ 個字母單字相鄰)→ 判定需要翻譯
  │  - 純數字/ID/代碼(SKU、價格)→ 略過
  │  抽樣前 30 列,命中率 > 50% 才列為可翻譯欄位
  ▼
③ analyzeContext()               src/lib/context.ts
  │  隨機抽 5 列 → Haiku 4.5 → 回傳 { domain, tone, notes }
  │  失敗時 fallback 為 { general, neutral, "" },不擋流程
  ▼
④ translateTable()               src/lib/translate.ts
  │  對每個目標語言:
  │  4a. buildNameGlossary()      src/lib/glossary.ts
  │      全文掃描(不是抽樣)→ Sonnet 5 → 找出重複出現的人名,
  │      統一成一份「表面形式 → 標準譯名」對照表
  │  4b. translateHeaders()       欄位標題翻譯(Haiku 4.5,best-effort)
  │  4c. 分批翻譯(BATCH_SIZE=12,MAX_CONCURRENT_BATCHES=10)
  │      每批呼叫 Sonnet 5,prompt 內強制套用 glossary + 語氣/領域 + 命名規則
  │      (漢字讀音標註、片假名人名、姓氏中的假名綴字等規則,見 translate.ts 內建規則)
  ▼
⑤ 品質防呆(translateBatchValidated,內建於 ④)
  │  檢查每列 _id 是否都有回傳、譯文是否仍殘留來源語言字元(如非日文卻含假名)
  │  失敗 → 整批重試一次;仍失敗 → 該列填空字串並計入 flaggedCount
  ▼
toCsv() → 回傳新 CSV(UTF-8-SIG)+ summary 文字
```

## 3. API 規格

### `POST /api/translate`

**Request**
```json
{
  "csv": "string (原始 CSV 內容)",
  "languages": [{ "code": "zh-TW", "name": "Chinese (Traditional)" }]
}
```

**限制**
- 最多 500 列(`MAX_ROWS`),超過直接回 400
- `maxDuration = 300` 秒(Vercel serverless function 上限)

**Response**
```json
{
  "summary": "string — 人類可讀摘要,含偵測到的欄位/語言/領域與 flaggedCount 警示",
  "csv": "string — 輸出 CSV",
  "columns": ["string — 被判定需翻譯的原始欄位"],
  "languages": [{ "code": "...", "name": "..." }],
  "rowCount": 0,
  "context": { "domain": "...", "tone": "...", "notes": "..." },
  "flaggedCount": 0
}
```

**錯誤情境**(皆回傳 400 + `{ error }`):
- 沒有 CSV 內容 / 沒選語言
- 解析不出任何 header 或 row
- 超過 500 列
- 找不到任何可翻譯欄位

## 4. 資料模型

| Type | 位置 | 說明 |
|---|---|---|
| `CsvTable` | `csv.ts` | `{ headers: string[], rows: Record<string,string>[] }` |
| `TranslationContext` | `context.ts` | `{ domain, tone, notes }`,單一份,套用到所有目標語言 |
| `Glossary` | `glossary.ts` | `Record<表面形式, 標準譯名>`,**每個目標語言各自一份** |
| `TargetLanguage` | `languages.ts` | 目前支援:English (USA)、Chinese (Traditional)、Chinese (Simplified)、Japanese |
| `TranslatedTable` | `translate.ts` | `CsvTable & { flaggedCount }` |

輸出欄位規則:每個原始欄位在每個目標語言下都會產生對應欄位(標題一律嘗試翻譯;內容只有被判定為可翻譯欄位才翻,其餘原樣複製),標題重複時自動加上 `(語言名稱)` 後綴去重。

## 5. 品質防呆機制

1. **Glossary 強制對齊**:因為翻譯是分批獨立呼叫、彼此無記憶,靠全文掃描建立的人名對照表在每批 prompt 中作為「必須遵守」的 override,避免同一人在不同批次譯名不一致。
2. **殘留來源語言偵測**:非日文的譯文若仍含假名字元,視為翻譯失敗,觸發整批重試。
3. **列數對齊檢查**:每批回傳的 `_id` 需與送出的列一一對應,缺列視為失敗。
4. **重試一次,不無限重試**:兩次都失敗則該列輸出空字串並累加 `flaggedCount`,回傳給使用者而非靜默吞掉。
5. Header 翻譯 / context 分析皆為 best-effort:LLM 呼叫失敗時 fallback 到原文/預設值,不會擋住整個翻譯流程。

## 6. 已知限制

- 單檔上限 500 列,無非同步/背景處理機制(Post-v1 規劃項目)
- 目標語言僅 4 種(`languages.ts` 寫死清單),無自訂字典/品牌詞匯入
- Context 分析對整份檔案只做一次、抽樣 5 列 → 假設全檔語氣/領域一致,混合領域的檔案可能失準
- 下載前沒有人工微調介面,`flaggedCount` 只在 summary 文字提醒,使用者需自行回頭核對哪幾格

## 7. Roadmap(Post-v1,對齊原評測報告)

- 大檔案非同步處理(後台排隊 + 進度條),解除 500 列限制
- 下載前人工微調介面:高亮低信心度的格子供修改
- 支援匯入公司自訂字典(品牌詞、產品專有名詞),與現有 glossary 機制合併
- **拆分為真正的 4 個獨立 Agent**(見下方 7.1),取代目前單一 route 內依序呼叫 function 的架構

### 7.1 未來架構:4-Agent 拆分計畫

目前 4 個階段是同步、耦合在同一支 request 裡的 function call,任一階段變慢或失敗都會拖垮整個 pipeline,也很難個別重試、個別擴充。未來規劃拆成 4 個可獨立運作、有明確輸入輸出邊界的 agent:

| # | Agent | 對應現有 function | 未來定位 |
|---|---|---|---|
| 1 | **Schema & Column Detector** | `detectSourceLanguage` / `detectTranslatableColumns`(`csv.ts`) | 保留規則式判斷(免 LLM 成本),但獨立成可單獨呼叫、可測試的服務,為後續非同步大檔案處理鋪路 |
| 2 | **Context & Domain Analyzer** | `analyzeContext`(`context.ts`) | 獨立 agent,結果可快取/複用(例如同一使用者重複上傳同類檔案時免重跑) |
| 3 | **Parallel Translation Engine** | `translateTable` + `buildNameGlossary`(`translate.ts` / `glossary.ts`) | 拆成背景 job,搭配 queue 處理 500 列以上的檔案,解除目前 `maxDuration=300` 的同步限制 |
| 4 | **Validation & Quality Guard** | `translateBatchValidated` 內建的檢查邏輯 | 從「翻譯失敗就重試」升級為獨立驗證步驟,產出的 `flaggedCount` 資料可以餵給未來的「人工微調介面」,精準標出哪幾格需要人工複核 |

**為什麼現在不做**:目前規模(單次同步請求、500 列上限)下,拆成獨立 agent 的 orchestration 成本(通訊、狀態管理、失敗重試)大於效益。等大檔案非同步處理與人工微調介面上線、確定有背景 job 架構的需求後,再把這 4 個階段真正拆開會比較合理。
