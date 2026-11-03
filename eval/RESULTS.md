# CSV Localizer: small evaluation (EN to zh-TW)

Run on 2026-11-02 (PT) against the real pipeline in `src/lib` (no mocks, no demo replay). Every number below comes from the JSON files in `eval/results/`.

## 1. What was tested

- **Pipeline under test:** the same functions the `/api/translate` route calls: `detectTranslatableColumns` (rules), `analyzeContext` (Claude Haiku 4.5), `translateTable` (glossary pass and 12-row batches on Claude Sonnet 5, header labels on Claude Haiku 4.5, then the built-in validation and retry).
- **Target language:** Chinese (Traditional), `zh-TW`, so Riley can spot-check as a native speaker.
- **Harness:** `tsc -p eval/tsconfig.eval.json` compiles `src/lib/*.ts` to `eval/.build/`, and `eval/run_eval.mjs` imports those modules directly. It wraps the Anthropic client to read `usage` from every API response.

## 2. Eval set (`eval/dataset.csv`)

26 rows, 4 columns: `key`, `type`, `text`, `max_chars`. Only `text` should be translated; `key`, `type` and `max_chars` must pass through untouched.

| Category | Rows | Examples |
|---|---|---|
| Short UI strings | 4 | `Save changes`, `Cancel`, `Error 404: Page not found` |
| Placeholders | 6 | `{name}`, `%d`, `%s`, `{{count}}`, `%1$s / %2$s`, `{first_name} #{order_id} {date}` |
| HTML | 3 | `<a href="/terms">`, `<strong>`/`<em>`, `<br>` |
| Numbers, units, dates, money | 5 | `$19.99`, `50 GB`, `March 3, 2026 9:30 PM PT`, `0°C (32°F)`, `75%` |
| Brand names (must stay as-is) | 5 | Notion, Stripe, Lexingtonight, Slack + n8n, iPhone |
| Longer descriptions | 2 | onboarding paragraph, privacy notice with a `Settings > Privacy` path |
| Multi-line cell | 1 | quoted CSV cell with a real line break |

Some rows cover more than one category (for example, the onboarding row also has "CSV").

## 3. Method

**Layer 1: code checks (deterministic), per row.** A row passes only if all of these hold:
- `non_empty`: translation is not blank
- `placeholders`: the same multiset of `{x}`, `{{x}}`, `%s`, `%d`, `%1$s` tokens as the source
- `html`: the exact same tag sequence, attributes included
- `numbers`: every number in the source appears in the output
- `brands`: every brand name in the source appears verbatim
- `line_breaks`: same number of `\n`
- `locale_terms`: no Mainland-China UI terms (文本, 字符, 軟件, 網絡, 信息, 默認, 視頻, 鏈接, 設置, 登錄, 賬)
- `translated`: output is not just the English copied through

File-level checks on every run: output row count = input row count, output column count = 2 × input, pass-through columns identical in both the original and the translated copy, `flaggedCount` from the pipeline.

**Layer 2: LLM judge, per row.** Claude Opus 5.5 (a different model from the Sonnet 5 translator), effort `low`, one call per row. It returns pass/fail for **accuracy** (full meaning, no additions or omissions) and **fluency** (natural Taiwan Mandarin, Taiwan terms), plus a one-sentence reason. A row passes the judge only if both pass. The judge also scored the 4 translated column headers.

**Time:** wall clock from column detection to the finished table (all model calls included, judge excluded), divided by 26 for per row.

**Cost:** input and output tokens from each response's `usage`, times list price (from the claude-api skill model table, cached 2026-10-06): Sonnet 5 $2 / $10 per 1M tokens in / out, Haiku 4.5 $1 / $5, Opus 5.5 (judge) $4 / $20. Cost per 100 rows = pipeline cost / 26 × 100. Judge cost is reported separately because it is not part of the product.

Each condition was run **3 times** because model output changes from run to run.

## 4. Results

### The four headline numbers (mean of 3 runs, range in brackets)

| Metric | Before fix | After fix |
|---|---|---|
| (a1) Code-check pass rate, rows | **97.5%** [96.2 to 100] | **97.5%** [96.2 to 100] |
| (a2) LLM-judge pass rate, rows | **97.5%** [96.2 to 100] | **93.6%** [84.6 to 100] |
| (a3) Column headers free of Mainland terms | **9 / 12 (75%)** | **11 / 12 (92%)** |
| (b) Processing time, total for 26 rows | **14.8 s** [10.6 to 17.3] | **20.3 s** [15.2 to 26.9] |
| (b) Processing time, per row | **569 ms** | **782 ms** |
| (c) Pipeline cost, 26 rows | **$0.0311** | **$0.0382** |
| (c) Pipeline cost per 100 rows | **$0.120** | **$0.147** |

File-level checks passed on all 6 runs: 26 rows in, 26 out; 8 columns out; `key`, `type`, `max_chars` untouched; only `text` detected as translatable; `flaggedCount` 0.

**How to read the after column.** The fix only touches the header call. Row translations, time and most of the cost come from the Sonnet batch calls, which the fix does not change. So the row and time differences between the columns are run-to-run noise, not an effect of the fix:
- Output tokens on the same input ranged from 1,427 to 2,967 across the six runs. That alone explains the cost and time spread.
- The fix itself adds about 62 input tokens to one Haiku call: $0.00006 per file.
- after_3 had the lowest judge score (84.6%). In that run Sonnet left `Share`, `Add to Home Screen` and `Settings > Privacy` in English. Those rows passed in the other 5 runs.

### Per-run detail

| Run | Code pass | Judge pass | Both | Headers clean | Time | Out tokens | $ / 100 rows |
|---|---|---|---|---|---|---|---|
| baseline_initial | 96.2% | 100% | 96.2% | 2/4 (文本, 最大字符數) | 16.5 s | 1,999 | 0.122 |
| baseline_1 | 100% | 96.2% | 96.2% | 3/4 (最大字符數) | 10.6 s | 1,427 | 0.100 |
| baseline_2 | 96.2% | 96.2% | 92.3% | 4/4 | 17.3 s | 2,383 | 0.137 |
| after_1 | 96.2% | 100% | 96.2% | 4/4 | 15.2 s | 2,201 | 0.130 |
| after_2 | 96.2% | 96.2% | 92.3% | 3/4 (文本) | 18.8 s | 2,735 | 0.151 |
| after_3 | 100% | 84.6% | 84.6% | 4/4 | 26.9 s | 2,967 | 0.160 |

`baseline_initial` ran before the `locale_terms` check and the header judge were added to the harness. Its cells were re-checked from the saved output afterwards (0 Mainland terms), so its row numbers are comparable. Its headers were checked for Mainland terms but not judged.

Per code check, across all 156 row-translations (6 runs × 26): placeholders 100%, HTML 100%, brands 100%, line breaks 100%, non-empty 100%, Mainland terms in cells 0, untranslated 0. The only code-check failure was `numbers` on the promo banner (4 of 6 runs): "save 20%" became 「8折」. That is correct Taiwan retail wording, and the judge passed it every time. It is a false positive of a strict check, but it is also worth a human look, because a promo number that changes form can matter legally.

### Header probe (bigger sample for the fix)

Four headers per run is too few to measure a slip that happens a few percent of the time. So `eval/probe_headers.mjs` calls the pipeline's own `translateHeaders()` many times, from builds of the original code (v0) and the fixed code (v1):

| Probe | Original code (v0) | Fixed code (v1) |
|---|---|---|
| The 4 dataset headers × 30 runs, with a real context-analyzer result | **5 / 120 Mainland labels (4.2%)**: 文本 ×3, 最大字符數 ×2 | **0 / 120** |
| 14 tempting headers (file_name, video_url, login_count...) × 10 runs, fixed context | **2 / 140 (1.4%)**: 最大字符數, 最大字符 | **0 / 140** |

A third build (v2: fixed prompt plus headers on Sonnet 5) also scored 0/120 and 0/140 at about 3× the header cost, so it was not adopted.

## 5. The failure and the fix

**Failure.** The translated column headers sometimes used Mainland-China terms in a zh-TW file: 「文本」 for *text* and 「最大字符數」 for *max_chars* (Taiwan: 文字, 字元). The cells underneath were always in Taiwan usage, so the file came out mixed.

**Root cause.** `translate.ts` has a `LOCALE_REGISTER_NOTES` table that tells the model to use Taiwan terms for zh-TW. The cell-translation prompt includes it. The header prompt (`translateHeaders`, on Haiku) never did.

**Fix (5 lines in `src/lib/translate.ts`).** `translateHeaders` now adds the same locale note to its system prompt. No new rules, no eval-specific word list in the product.

**Effect.** Mainland header labels went from 5/120 to 0/120 in the probe, and from 3/12 to 1/12 in the full runs. The one slip that remained after the fix (文本 in after_2) means a prompt note alone is not a guarantee. The next step would be a deterministic header check with a retry, the same pattern the pipeline already uses for leftover kana in cells.

## 6. Other things the eval surfaced (not fixed)

1. **Formal vs informal "you" flips between runs.** Four runs used 您 throughout, two used 你 throughout. Each file is consistent inside itself, but two uploads of the same file can come back in different registers. A fixed register per locale (or per user choice) in the prompt would fix it.
2. **"Scheduled maintenance" became 「例行維護」 (routine maintenance)** in 4 of 6 runs; 「預定維護」 would be accurate. The judge failed it in 3 of those 4 and passed it once, so the judge is not fully consistent either.
3. **UI labels left in English** (`Settings > Privacy`, `Share`) in 1 of 6 runs.
4. **Unit doubled:** 「攝氏0°C」 says Celsius twice. The judge flagged it once.
5. **Spacing between Chinese and numbers is inconsistent** (「8個字元」 next to 「50 GB 儲存空間」). Not measured by any check yet.

## 7. Limits

- **Small sample.** 26 rows, one language pair, one domain (software UI). 3 runs per condition. The row-level differences between before and after are inside run-to-run noise.
- **The LLM judge has not been checked against a human yet.** Per run it passed 84.6 to 100% of rows, and it scored the same 「例行維護」 output as a pass once and a fail three times. It may be lenient and it is not fully consistent. The 5 rows below are for that comparison.
- **Synthetic set.** Rows were written for this eval, not taken from a real customer file.
- **Code checks are strict proxies.** The number check flagged a correct 「8折」; the Mainland-term list is short and hand-picked.
- **Prices are list prices** from the skill's model table, not an invoice.
- **Time is API latency from one laptop**, sequential runs, no load.

## 8. Rows for Riley to spot-check by hand

Please mark each as pass or fail for accuracy and for fluency, then compare with the judge column. All five are from `results/after_3.json` (the run with the most judge failures).

| # | key | Source | Translation | Judge (acc / flu) | Riley (acc / flu) |
|---|---|---|---|---|---|
| 1 | notice.maintenance | Scheduled maintenance on March 3, 2026 from 9:30 PM to 11:00 PM PT. | 系統將於 2026 年 3 月 3 日晚上 9:30 至 11:00（PT）進行例行維護。 | fail / pass | |
| 2 | help.iphone | Open the app on your iPhone and tap Share, then Add to Home Screen. | 在 iPhone 上開啟 App，點一下「Share」，然後選擇「Add to Home Screen」。 | fail / fail | |
| 3 | legal.privacy | We only use your data to provide the service. You can export or delete your account at any time from Settings > Privacy. | 我們只會將你的資料用於提供服務。你可以隨時從 Settings > Privacy 匯出或刪除你的帳號。 | fail / fail | |
| 4 | onboarding.intro | Start by importing a CSV file. We will detect which columns need translation, keep IDs and prices untouched, and return a localized copy you can download in under a minute. | 先匯入一個 CSV 檔案，我們會自動偵測哪些欄位需要翻譯，保留 ID 和價格不變，並在一分鐘內提供可下載的在地化版本。 | pass / pass | |
| 5 | email.shipped | Hi {first_name}, your order #{order_id} has shipped and should arrive by {date}. | 嗨 {first_name}，你的訂單 #{order_id} 已出貨，預計 {date} 前送達。 | pass / pass | |

## 9. Spend

| Item | USD |
|---|---|
| 6 full runs, pipeline | 0.208 |
| 6 full runs, judge (Opus 5.5) | 0.672 |
| Header probes (2 probes × 3 builds) | 0.150 |
| One context-analyzer call in the dataset probe (Haiku, not metered) | under 0.001 |
| **Total** | **about $1.03** |

## 10. Reproduce

```bash
cd translation-agent
env -u NODE_OPTIONS node_modules/.bin/tsc -p eval/tsconfig.eval.json
env -u NODE_OPTIONS node --env-file-if-exists=.env --env-file-if-exists=.env.local eval/run_eval.mjs <label>
```

`env -u NODE_OPTIONS` is only needed on this machine (a terminal preload breaks `node`). The probe needs the three builds in `eval/.build-probe/` (git-ignored): v0 = `git show c3f2fff:src/lib/translate.ts`, v1 = current `translate.ts`, v2 = v1 with `UTILITY_MODEL` swapped for `TRANSLATION_MODEL` in `translateHeaders`. Each gets `export { translateHeaders };` appended and is compiled with `tsc` to `.build-probe/<v>/out`. Then `node eval/probe_headers.mjs 30 dataset` or `node eval/probe_headers.mjs 10 wide`.
